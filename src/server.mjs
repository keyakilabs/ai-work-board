/**
 * 板のサーバ。
 *
 * 依存は Node の標準モジュールだけ。外へ HTTP を投げるコードはこのリポジトリ
 * のどこにも無い（test/no-outbound.test.mjs がそれを機械的に確かめている）。
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  readItems, readClosed, readTasks, readTask, groupForBoard, sortClosed,
  createItem, answerItem, closeItem, reopenItem, createTask, moveTask,
  ensureBoard, boardPaths,
  mayReadFromBoard,
} from './board.mjs';
import {
  CSRF_HEADER, newToken, tokensMatch, hostIsOurs, originIsOurs, isSafeEntryId, safeWebPath, isInside,
} from './security.mjs';
import { demoBoard } from './demo.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

class BadBody extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * 上限を超えたら読むのをやめるが、**接続は切らない**。
 * 切ると相手には「返事が来ない」だけになり、何が起きたのか分からないまま
 * 待たされる。上限超過はこちらの都合なので、413 でそう言う。
 */
async function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let stopped = false;
    const chunks = [];
    req.on('data', (c) => {
      if (stopped) return;
      size += c.length;
      if (size > limit) {
        stopped = true;
        req.resume(); // 残りは読み捨てる。読まないとソケットが詰まる
        reject(new BadBody('送られてきた内容が大きすぎます', 413));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (stopped) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new BadBody('内容が JSON として読めません', 400)); }
    });
    req.on('error', reject);
  });
}

/**
 * 日付だけのアクセス記録。
 * 「毎日開いているか」を自己申告ではなく実測するために置いている。
 * 時刻も URL も IP も残さない。`--no-log` で止まる。
 */
function noteAccess(enabled) {
  if (!enabled) return;
  try {
    const dir = path.join(os.homedir(), '.ai-work-board');
    fsSync.mkdirSync(dir, { recursive: true });
    // 「その日開いたか」を測るので、UTC ではなく手元の日付で数える。
    // 深夜に開いた日が前日として記録されると、測りたいものが測れない
    const n = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const today = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
    const file = path.join(dir, 'access.log');
    const seen = fsSync.existsSync(file) ? fsSync.readFileSync(file, 'utf8') : '';
    if (!seen.split('\n').includes(today)) fsSync.appendFileSync(file, `${today}\n`);
  } catch { /* 記録できなくても板は動く */ }
}

export async function createServer(opts = {}) {
  const {
    workspace = process.cwd(),
    port = 3457,
    demo = false,
    log = true,
  } = opts;

  const token = newToken();
  const clients = new Set();
  let actualPort = port;

  if (!demo) await ensureBoard(workspace);

  async function snapshot() {
    if (demo) return { ...demoBoard(), demo: true, workspace: '(demo)' };
    /*
     * 状態を決めるのは frontmatter の `status` だけ。**置き場は状態ではない。**
     *
     * `items/` と `closed/` は棚で、`closed/` は「もう読まなくていいものの置き場」。
     * だから2つを混ぜてから `status` で分ける — `items/` に居るのに閉じている紙
     * （Claude が動かし忘れたもの）も片付いたに出るし、`closed/` に居るのに
     * 開いている紙も受付に出る。置き場は次の書き込みのときに揃う。
     */
    // 棚の奥ぶんも全部渡す（`readClosed` の既定の40件は「画面に出す数」なので、
    // ここで切ると `closed/` に居る開いた紙を取りこぼす）
    const [live, shelved, tasks] = await Promise.all([
      readItems(workspace), readClosed(workspace, Infinity), readTasks(workspace),
    ]);
    const { done, ...grouped } = groupForBoard([...live, ...shelved]);
    return {
      ...grouped, closed: sortClosed(done), tasks,
      demo: false, workspace,
      boardDir: boardPaths(workspace).root,
      // 古い置き場（.claude/board/）のままだと Claude が板に書けない。
      // 画面で気づけるように渡す
      legacyDir: boardPaths(workspace).legacy,
    };
  }

  /**
   * 板が変わったことを押し出す。
   *
   * 1回の書き込みで、ここは何度も呼ばれる — 書いた直後に1回、その書き込みを
   * 見つけた監視が1回、ファイルの移動でもう1回。中身が同じなら送らない。
   * 送ると画面が作り直され、そのたびに紙が瞬く。
   */
  let lastSent = null;
  function broadcast() {
    snapshot().then((s) => {
      const body = JSON.stringify(s);
      if (body === lastSent) return;
      lastSent = body;
      const payload = `event: board\ndata: ${body}\n\n`;
      for (const res of clients) { try { res.write(payload); } catch { /* 切れた接続 */ } }
    }).catch(() => {});
  }

  // 板のファイルが変わったら押し出す。板は Claude も人も直接書くので、
  // 画面からの操作だけを見ていては足りない。
  let watcher = null;
  if (!demo) {
    try {
      watcher = fsSync.watch(boardPaths(workspace).root, { recursive: true }, () => {
        clearTimeout(watcher._t);
        watcher._t = setTimeout(broadcast, 120); // 連続イベントをまとめる
      });
    } catch { /* watch が使えない環境では画面の操作時だけ更新する */ }
  }

  const server = http.createServer(async (req, res) => {
    // `GET //` のような不正なリクエストターゲットは new URL が投げる。
    // ここで落とすと、任意のページからの1リクエストでサーバが死ぬ
    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
    } catch {
      return json(res, 400, { error: 'リクエストの形式が不正' });
    }
    // 絶対形式（GET http://evil.example/… ）で来たときは、Host だけ見ると
    // 通ってしまう。宛先そのものが自分かどうかも確かめる
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(req.url) && !hostIsOurs({ headers: { host: url.host } }, actualPort)) {
      return json(res, 400, { error: '宛先がこの板ではない' });
    }
    const isWrite = req.method === 'POST';

    // 埋め込みを禁じる。フレームに入れられると、画面を踏ませるだけで
    // Origin 検査と CSRF トークンの2枚が意味を失う
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "frame-ancestors 'none'");
    res.setHeader('referrer-policy', 'no-referrer');

    // 1枚目: Host。読み取りにも掛ける（DNS リバインディング対策）
    if (!hostIsOurs(req, actualPort)) return json(res, 403, { error: 'この板は自分のマシンからしか開けない' });

    // 2枚目/3枚目: 書き込みは Origin と CSRF トークンを要求する
    if (isWrite) {
      if (!originIsOurs(req, actualPort)) return json(res, 403, { error: '別のサイトからは書き込めない' });
      if (!tokensMatch(req.headers[CSRF_HEADER], token)) return json(res, 403, { error: 'トークンが違う' });
      if (demo) return json(res, 403, { error: 'demo では書き込めない' });
    }

    try {
      if (url.pathname === '/api/board' && req.method === 'GET') {
        // demo は「自分のデータを見せる前に確かめる」ためのモード。
        // 読まないと言っている以上、書きもしない
        noteAccess(log && !demo);
        return json(res, 200, { ...(await snapshot()), token });
      }

      if (url.pathname === '/api/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(`event: board\ndata: ${JSON.stringify(await snapshot())}\n\n`);
        clients.add(res);
        const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch { /* noop */ } }, 25000);
        req.on('close', () => { clearInterval(beat); clients.delete(res); });
        return undefined;
      }

      /**
       * 画面に出ている1件が、ディスクのどのファイルなのかを見せる。
       *
       * このツールは「板の正本は md であって画面は窓にすぎない」と言って
       * いるので、その md を実際に見られないと、ただの主張になる。
       */
      if (url.pathname === '/api/raw' && req.method === 'GET') {
        if (demo) {
          return json(res, 200, {
            demo: true,
            path: '（demo なのでファイルはありません）',
            text: 'demo モードでは、あなたのディスクを一切読んでいません。\n'
              + '本物の板では、ここにそのファイルの中身がそのまま出ます。',
          });
        }
        const id = url.searchParams.get('id');
        if (!isSafeEntryId(id)) return json(res, 400, { error: 'id が不正' });

        const lane = url.searchParams.get('lane');
        if (lane) {
          const t = await readTask(workspace, lane, id).catch(() => null);
          if (!t) return json(res, 404, { error: 'そのタスクは見つかりません' });
          return json(res, 200, t);
        }

        const where = url.searchParams.get('where') ?? 'items';
        if (!['items', 'closed'].includes(where)) return json(res, 400, { error: 'where が不正' });
        const dir = boardPaths(workspace)[where];
        const file = path.join(dir, `${id}.md`);
        if (!isInside(dir, file)) return json(res, 400, { error: 'パスが板の外を指している' });
        // 文字列の突き合わせだけだと、板の中に置かれたシンボリックリンク経由で
        // 板の外の中身を画面に映せてしまう。実体で確かめる
        if (!await mayReadFromBoard(workspace, file)) {
          return json(res, 400, { error: '板の外を指すファイルは読めない' });
        }
        try {
          return json(res, 200, { path: file, text: await fs.readFile(file, 'utf8') });
        } catch {
          return json(res, 404, { error: 'ファイルが見つからない（もう片付けられたかもしれません）' });
        }
      }

      /** 答える。既定では「Claude 待ち」になる。close を立てると完了まで進む。 */
      if (url.pathname === '/api/answer' && isWrite) {
        const { id, answer, close } = await readJsonBody(req);
        if (!isSafeEntryId(id)) return json(res, 400, { error: 'id が不正' });
        const r = await answerItem(workspace, id, answer, { close: close === true });
        broadcast();
        return json(res, 200, { ok: true, ...r });
      }

      /** 完了にする / 取り下げる。 */
      if (url.pathname === '/api/close' && isWrite) {
        const { id, withdrawn } = await readJsonBody(req);
        if (!isSafeEntryId(id)) return json(res, 400, { error: 'id が不正' });
        const r = await closeItem(workspace, id, { withdrawn: withdrawn === true });
        broadcast();
        return json(res, 200, { ok: true, ...r });
      }

      /** 板に戻す（答えの取り消し・完了の取り消し）。 */
      if (url.pathname === '/api/reopen' && isWrite) {
        const { id } = await readJsonBody(req);
        if (!isSafeEntryId(id)) return json(res, 400, { error: 'id が不正' });
        const r = await reopenItem(workspace, id);
        broadcast();
        return json(res, 200, { ok: true, ...r });
      }

      /** こちらからスレッドを立てる（Claude への伝言もこの形で置く）。 */
      if (url.pathname === '/api/item' && isWrite) {
        const { title, body, kind, priority, project } = await readJsonBody(req);
        if (!title || !String(title).trim()) return json(res, 400, { error: '見出しが空' });
        const r = await createItem(workspace, {
          title, body: String(body ?? ''), kind: kind || 'action',
          priority: priority || 'normal', project: project || '',
          // 画面から入った印。ただし出どころの保証ではない（誰でも書ける）
          origin: 'board-ui', from: 'you',
          // こちらから出したスレッドは、出した時点で Claude の番
          status: 'answered',
        });
        broadcast();
        return json(res, 200, { ok: true, ...r });
      }

      /** タスクを立てる。 */
      if (url.pathname === '/api/task' && isWrite) {
        const { title, body, lane } = await readJsonBody(req);
        if (!title || !String(title).trim()) return json(res, 400, { error: '見出しが空' });
        const r = await createTask(workspace, { title, body: String(body ?? ''), lane: lane || 'inbox' });
        broadcast();
        return json(res, 200, { ok: true, ...r });
      }

      /** タスクをレーン間で動かす。 */
      if (url.pathname === '/api/task-move' && isWrite) {
        const { id, from, to } = await readJsonBody(req);
        if (!isSafeEntryId(id)) return json(res, 400, { error: 'id が不正' });
        const r = await moveTask(workspace, id, from, to);
        broadcast();
        return json(res, 200, { ok: true, ...r });
      }

      if (req.method === 'GET') {
        const file = safeWebPath(WEB_ROOT, url.pathname);
        if (!file) return json(res, 403, { error: 'だめ' });
        try {
          const buf = await fs.readFile(file);
          res.writeHead(200, {
            'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          return res.end(buf);
        } catch {
          return json(res, 404, { error: 'ない' });
        }
      }

      return json(res, 404, { error: 'ない' });
    } catch (e) {
      // 「そのエントリが無い」は利用者側の話。サーバの異常として返さない
      const code = e?.status ?? (e?.code === 'ENOENT' ? 404 : 500);
      const message = e?.code === 'ENOENT'
        ? 'そのエントリは見つかりませんでした（もう片付けられたかもしれません）'
        : String(e?.message ?? e);
      return json(res, code, { error: message });
    }
  });

  // 1本の接続の失敗でプロセスごと落とさない
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });

  return {
    server,
    token,
    get port() { return actualPort; },
    async listen(p = port) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        // 127.0.0.1 固定。公開用のオプションは作らない（作らないことが設計）
        server.listen(p, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      actualPort = server.address().port;
      return actualPort;
    },
    async close() {
      watcher?.close();
      for (const c of clients) { try { c.end(); } catch { /* noop */ } }
      clients.clear();
      await new Promise((r) => server.close(r));
    },
  };
}
