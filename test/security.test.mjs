/**
 * この板の「安全だから使える」という主張を、主張のまま置かないためのテスト。
 *
 * 127.0.0.1 に bind しただけでは守れないことが3つある:
 *   - 同じマシンのブラウザで開いた別サイトからは届く（CSRF）
 *   - 攻撃者のドメインを 127.0.0.1 に向ければ Host は通る（DNS リバインディング）
 *   - 板の隣は ~/.claude/settings.json で、1階層の脱出が任意コード実行になる
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import { createServer } from '../src/server.mjs';
import { isSafeEntryId, safeWebPath, isInside } from '../src/security.mjs';
import { createItem, answerItem, boardPaths, ensureBoard } from '../src/board.mjs';

async function boot() {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-sec-'));
  const app = await createServer({ workspace: ws, port: 0, log: false });
  const port = await app.listen(0);
  return { ws, app, port, base: `http://127.0.0.1:${port}` };
}

const hit = (base, p, init = {}) => fetch(`${base}${p}`, init);

/**
 * `fetch` は Host を禁止ヘッダとして黙って捨てるので、Host を偽る攻撃は
 * fetch では再現できない。生の HTTP で送る。
 */
function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('127.0.0.1 にだけ bind し、他のインターフェースでは待ち受けない', async () => {
  const c = await boot();
  try {
    assert.equal(c.app.server.address().address, '127.0.0.1');
  } finally { await c.app.close(); }
});

test('Host が自分でないリクエストは読み取りでも拒否する（DNS リバインディング）', async () => {
  const c = await boot();
  try {
    // 攻撃者のドメインを 127.0.0.1 に向けられても、Host で見分けて止める
    assert.equal(await rawGet(c.port, '/api/board', { Host: 'evil.example.com' }), 403);
    assert.equal(await rawGet(c.port, '/api/board', { Host: `127.0.0.1:${c.port}` }), 200);
  } finally { await c.app.close(); }
});

test('別オリジンからの書き込みは拒否する', async () => {
  const c = await boot();
  const token = (await (await hit(c.base, '/api/board')).json()).token;

  const cases = [
    ['Origin 無し', {}],
    ['別オリジン', { Origin: 'https://evil.example.com' }],
    ['偽装 Referer', { Referer: 'https://evil.example.com/x' }],
    ['Origin: null', { Origin: 'null' }],
  ];
  try {
  for (const [name, extra] of cases) {
    const res = await hit(c.base, '/api/item', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-token': token, ...extra },
      body: JSON.stringify({ title: 'のっとり' }),
    });
    assert.equal(res.status, 403, `${name} が通ってしまった`);
  }
  } finally { await c.app.close(); }
});

test('トークンが無い/違う書き込みは拒否する', async () => {
  const c = await boot();
  // ヘッダ値は ByteString なので ASCII で用意する
  for (const token of [undefined, '', 'nonsense', 'a'.repeat(64)]) {
    const res = await hit(c.base, '/api/item', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: c.base,
        ...(token === undefined ? {} : { 'x-board-token': token }),
      },
      body: JSON.stringify({ title: 'のっとり' }),
    });
    assert.equal(res.status, 403, `token=${JSON.stringify(token)} が通ってしまった`);
  }
  await c.app.close();
});

test('正しい Origin とトークンなら書ける', async () => {
  const c = await boot();
  const token = (await (await hit(c.base, '/api/board')).json()).token;
  const res = await hit(c.base, '/api/item', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: c.base, 'x-board-token': token },
    body: JSON.stringify({ title: '通ること' }),
  });
  assert.equal(res.status, 200);

  // 画面から書いたものには印が付く（ただし出どころの保証ではない）
  const board = await (await hit(c.base, '/api/board')).json();
  const placed = board.theirs.find((e) => e.title === '通ること');
  assert.ok(placed, '置いたスレッドが Claude 待ちに出てこない');
  assert.equal(placed.origin, 'board-ui');
  await c.app.close();
});

test('板の外を指す id は、文字種の段階で全部落ちる', () => {
  const attacks = [
    '../settings', '../../settings', '..%2fsettings', '%2e%2e%2fsettings',
    '/etc/passwd', 'a/../../b', './x', '.hidden', 'a\0b', 'a/b', 'a\\b',
    '..', '', 'x'.repeat(201),
  ];
  for (const a of attacks) assert.equal(isSafeEntryId(a), false, `${JSON.stringify(a)} が通ってしまった`);
  assert.equal(isSafeEntryId('20260920-194417-fix-billing'), true);
});

test('板の外を指す id を投げても 400 で止まる', async () => {
  const c = await boot();
  const token = (await (await hit(c.base, '/api/board')).json()).token;
  for (const id of ['../../../settings', '..%2f..%2fsettings', 'a/b']) {
    const res = await hit(c.base, '/api/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: c.base, 'x-board-token': token },
      body: JSON.stringify({ id, answer: 'x' }),
    });
    assert.equal(res.status, 400, `${id} が 400 にならなかった`);
  }
  await c.app.close();
});

test('静的配信は web/ の外に出られない', () => {
  const webRoot = path.resolve('web');
  for (const p of ['/../src/server.mjs', '/../../etc/passwd', '/%2e%2e/package.json', '/../package.json']) {
    assert.equal(safeWebPath(webRoot, p), null, `${p} が通ってしまった`);
  }
  assert.ok(safeWebPath(webRoot, '/app.js'));
  assert.ok(safeWebPath(webRoot, '/panes/ask.mjs'));
});

test('isInside は隣の似た名前のディレクトリを中と見なさない', () => {
  assert.equal(isInside('/a/board', '/a/board-evil/x'), false);
  assert.equal(isInside('/a/board', '/a/board/x'), true);
  assert.equal(isInside('/a/board', '/a/board'), false);
});

test('書き込みは板の中にしか起きない（実地確認）', async () => {
  const c = await boot();
  const token = (await (await hit(c.base, '/api/board')).json()).token;
  const before = await fs.readdir(c.ws);

  await hit(c.base, '/api/item', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: c.base, 'x-board-token': token },
    body: JSON.stringify({ title: 'どこに書かれるか' }),
  });

  assert.deepEqual(await fs.readdir(c.ws), before); // ワークスペース直下は変わらない
  const entries = await fs.readdir(boardPaths(c.ws).items);
  assert.equal(entries.length, 1);
  await c.app.close();
});

test('demo では読み込みも書き込みも自分のファイルに触らない', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-demo-'));
  const app = await createServer({ workspace: ws, port: 0, demo: true, log: false });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const board = await (await hit(base, '/api/board')).json();
  assert.equal(board.demo, true);
  assert.ok(board.waiting.length > 0);

  const res = await hit(base, '/api/item', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: base, 'x-board-token': board.token },
    body: JSON.stringify({ title: 'demo で書けないこと' }),
  });
  assert.equal(res.status, 403);

  // demo は板のディレクトリを作りさえしない
  await assert.rejects(fs.access(boardPaths(ws).root), '板のディレクトリを作っている');
    await assert.rejects(fs.access(path.join(ws, '.claude')), '.claude を作っている');
  await app.close();
});

test('大きすぎる body は受け取らない', async () => {
  const c = await boot();
  const token = (await (await hit(c.base, '/api/board')).json()).token;
  const res = await hit(c.base, '/api/item', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: c.base, 'x-board-token': token },
    body: JSON.stringify({ title: 'x', body: 'あ'.repeat(200000) }),
  }).catch(() => ({ status: 0 }));
  assert.notEqual(res.status, 200);
  await c.app.close();
});

/* ── 出どころ（/api/raw）──────────────────────────────────
 * 画面に出ている1件の md を、そのまま読めるようにした口。
 * 読み取りだからこそ、板の外を読ませない守りが要る。
 */

test('出どころ: 板のエントリの md をそのまま返す', async () => {
  const c = await boot();
  try {
    const { id } = await createItem(c.ws, {
      kind: 'decision', title: '本番昇格は人が承認する', body: '自動昇格は戻せないため。',
    });
    const res = await hit(c.base, `/api/raw?where=items&id=${encodeURIComponent(id)}`);
    assert.equal(res.status, 200);
    const { path: p, text } = await res.json();

    // 画面が言っているパスが、実際にそのファイルであること
    assert.equal(p, path.join(boardPaths(c.ws).items, `${id}.md`));
    assert.equal(text, await fs.readFile(p, 'utf8'));
    assert.match(text, /^---\nid: /);
    assert.match(text, /\nkind: decision\n/);
    assert.match(text, /自動昇格は戻せないため。/);
  } finally { await c.app.close(); }
});

test('出どころ: 板の外のファイルは読めない', async () => {
  const c = await boot();
  try {
    const attacks = [
      'where=items&id=../../settings',
      'where=items&id=..%2f..%2fsettings',
      'where=items&id=%2e%2e%2fsettings',
      'where=../..&id=x',
      'where=/etc&id=passwd',
      'where=items&id=.hidden',
      'where=items&id=a/b',
    ];
    for (const q of attacks) {
      const res = await hit(c.base, `/api/raw?${q}`);
      assert.equal(res.status, 400, `${q} が 400 にならなかった`);
    }
  } finally { await c.app.close(); }
});

test('出どころ: Host を偽ったリクエストからは読めない', async () => {
  const c = await boot();
  try {
    const { id } = await createItem(c.ws, { kind: 'fyi', title: '作業中' });
    assert.equal(await rawGet(c.port, `/api/raw?where=items&id=${id}`, { Host: 'evil.example.com' }), 403);
  } finally { await c.app.close(); }
});

test('出どころ: demo では自分のファイルを読まない', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-demoraw-'));
  const app = await createServer({ workspace: ws, port: 0, demo: true, log: false });
  const port = await app.listen(0);
  try {
    const res = await hit(`http://127.0.0.1:${port}`, '/api/raw?where=items&id=demo-ask-1');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.demo, true);
    await assert.rejects(fs.access(boardPaths(ws).root), '板のディレクトリを作っている');
    await assert.rejects(fs.access(path.join(ws, '.claude')), '.claude を作っている');
  } finally { await app.close(); }
});

test('出どころ: 無いファイルは 404 で、理由が分かる', async () => {
  const c = await boot();
  try {
    const res = await hit(c.base, '/api/raw?where=items&id=20260101-000000-nope');
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /見つからない/);
  } finally { await c.app.close(); }
});


test('受付に戻す操作も Origin とトークンを要求する', async () => {
  const c = await boot();
  try {
    const token = (await (await hit(c.base, '/api/board')).json()).token;
    const { id } = await createItem(c.ws, { kind: 'confirm', title: 'どっち' });
    await hit(c.base, '/api/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: c.base, 'x-board-token': token },
      body: JSON.stringify({ id, answer: 'A' }),
    });

    // 別オリジンからは戻せない
    const evil = await hit(c.base, '/api/reopen', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://evil.example.com', 'x-board-token': token },
      body: JSON.stringify({ id }),
    });
    assert.equal(evil.status, 403);

    // 板の外を指す id も通らない
    const bad = await hit(c.base, '/api/reopen', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: c.base, 'x-board-token': token },
      body: JSON.stringify({ id: '../../settings' }),
    });
    assert.equal(bad.status, 400);

    // 正しく叩けば戻る
    const ok = await hit(c.base, '/api/reopen', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: c.base, 'x-board-token': token },
      body: JSON.stringify({ id }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await (await hit(c.base, '/api/board')).json()).waiting.length, 1);
  } finally { await c.app.close(); }
});

/* ── 落とされない・出ていかない ──────────────────────────
 * レビューで見つかった、テストの網の目の外側にあったもの。
 */

test('不正なリクエストターゲットを投げられてもサーバが死なない', async () => {
  const c = await boot();
  try {
    // `GET //` は new URL が投げる。ここで落ちると1リクエストでサーバが死ぬ
    const bad = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: c.port, path: '//', headers: { Host: `127.0.0.1:${c.port}` } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
      );
      req.on('error', () => resolve(0));
      req.end();
    });
    assert.ok(bad >= 400 && bad < 500, `4xx で返るべきだった（${bad}）`);

    // そのあとも普通に使える
    const after = await hit(c.base, '/api/board');
    assert.equal(after.status, 200, 'サーバが死んでいる');
  } finally { await c.app.close(); }
});

test('フレームへの埋め込みを禁じている（Origin と CSRF を迂回させない）', async () => {
  const c = await boot();
  try {
    const res = await hit(c.base, '/');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  } finally { await c.app.close(); }
});

test('板の中身がシンボリックリンクで外を指していたら、書かずに断る', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-outside-'));

  // items を板の外へ向けたリンクにする
  const p = boardPaths(ws);
  await fs.mkdir(p.root, { recursive: true });
  await fs.mkdir(p.closed, { recursive: true });
  await fs.mkdir(p.tasks, { recursive: true });
  await fs.symlink(outside, p.items, 'dir');

  await assert.rejects(
    () => createItem(ws, { kind: 'confirm', title: 'すり抜けを狙う' }),
    /板の外/,
    'リンク越しに板の外へ書けてしまった',
  );
  assert.deepEqual(await fs.readdir(outside), [], '板の外にファイルが作られた');
});

test('板の中のリンクが外のファイルを指していても、そこには書かない', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-link2-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-outside2-'));
  const target = path.join(outside, 'settings.json');
  await fs.writeFile(target, '{"keep":true}', 'utf8');

  const p = await ensureBoard(ws);
  const { id } = await createItem(ws, { kind: 'confirm', title: 'link' });

  // 片付け先を、外のファイルへのリンクにすり替える
  await fs.symlink(target, path.join(p.closed, `${id}.md`));

  await assert.rejects(
    () => answerItem(ws, id, 'A', { close: true }),
    /板の外/,
    'リンク先（板の外）を上書きしてしまった',
  );
  assert.equal(await fs.readFile(target, 'utf8'), '{"keep":true}', '外のファイルが書き換わった');
});


/* ── 板の外への書き込み ─────────────────────
 * README は「書き込み先は .board/ の中だけ」と言い切っており、例外は
 * `~/.ai-work-board/access.log` 1つだけだと書いている。ところが既定は
 * log 有効なのに、これまでのテストは全部 `log: false` で起動していたので、
 * **既定の経路を一度も通っていなかった**。
 */
test('既定で起動しても、ホームに作るのは access.log 1本だけ', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-home-'));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-log-'));
  const realHome = process.env.HOME;
  process.env.HOME = home;                 // os.homedir() は POSIX で $HOME を見る
  try {
    const app = await createServer({ workspace: ws, port: 0 });   // log を渡さない＝既定
    const port = await app.listen(0);
    await hit(`http://127.0.0.1:${port}`, '/api/board');
    await app.close();
  } finally {
    process.env.HOME = realHome;
  }

  const found = [];
  async function walk(dir, rel = '') {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const here = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(path.join(dir, d.name), here);
      else found.push(here);
    }
  }
  await walk(home);

  /*
   * 板が自分で書くのは access.log だけ。ただし板は「いまの作業」を出すために
   * `claude agents --json` を起動するので、**その CLI が自分の設定ファイルを
   * 触る**（`~/.claude.json` とそのバックアップ）。板が書いているのではないが、
   * 板を起動した結果として増えるものなので、ここで名指しして分けておく。
   * README にもそう書いてある。
   */
  const cliOwn = (f) => f === '.claude.json' || f.startsWith('.claude/');
  const ours = found.filter((f) => !cliOwn(f));
  assert.deepEqual(ours, ['.ai-work-board/access.log'], `板が書いたもの: ${ours.join(', ')}`);

  // 看板の約束。CLI が自分の設定を触っても、settings.json には手が出ていないこと
  assert.ok(!found.includes('.claude/settings.json'), 'settings.json を作っている');

  // 中身は日付1行だけ。時刻も URL も IP も残さない、と README で言っている
  const body = await fs.readFile(path.join(home, '.ai-work-board', 'access.log'), 'utf8');
  for (const line of body.split('\n').filter(Boolean)) {
    assert.match(line, /^\d{4}-\d{2}-\d{2}$/, `日付以外が書かれている: ${line}`);
  }
});

test('画面の CSP が緩んでいない', async () => {
  const html = await fs.readFile(path.join(ROOT_DIR, 'web', 'index.html'), 'utf8');
  const m = html.match(/content="([^"]*default-src[^"]*)"/);
  assert.ok(m, 'meta の CSP が見つからない');
  const csp = m[1];
  for (const must of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "form-action 'none'"]) {
    assert.ok(csp.includes(must), `CSP から消えている: ${must}`);
  }
  for (const never of ['unsafe-inline', 'unsafe-eval', 'http://', 'https://', '*']) {
    assert.ok(!csp.includes(never), `CSP が緩んでいる: ${never}`);
  }
});

test('板に置かれたシンボリックリンク越しに、板の外は読めない', async () => {
  // 板はファイルを置ける者なら誰でも書ける前提。`items/x.md -> ~/.ssh/id_rsa`
  // のような細工で、画面が板の外の中身を映さないこと（verifier の指摘）
  const { ws, app, port, base } = await boot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-outside-'));
  const secret = path.join(outside, 'secret.md');
  await fs.writeFile(secret, 'TOP-SECRET\n');

  const p = boardPaths(ws);
  await ensureBoard(ws);
  await fs.symlink(secret, path.join(p.items, 'peek.md'));
  await fs.symlink(secret, path.join(p.lanes.inbox, 'peek.md'));

  const asItem = await (await hit(base, '/api/raw?where=items&id=peek')).json();
  assert.ok(!('text' in asItem), `板の外を読めてしまった: ${JSON.stringify(asItem).slice(0, 120)}`);
  assert.match(asItem.error, /板の外/);

  const asTask = await (await hit(base, '/api/raw?lane=inbox&id=peek')).json();
  assert.ok(!('text' in asTask), `タスク経由で板の外を読めてしまった: ${JSON.stringify(asTask).slice(0, 120)}`);

  // 無いファイルは、これまでどおり「無い」と返る（404 が 400 に化けない）
  const missing = await hit(base, '/api/raw?where=items&id=nope');
  assert.equal(missing.status, 404);

  await app.close();
});

test('ポートが埋まっていたら、次の空きを自分で探す', async () => {
  // プロジェクトごとに板を立てるのはふつうのことなので、2つ目で
  // 「使われています」と言って止まるのは道具側の怠慢
  const a = await boot();
  const bWs = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-port-'));
  const app = await createServer({ workspace: bWs, port: 0, log: false });

  // 1つ目が使っている番号を指定して、EADDRINUSE が起きることを先に確かめる
  await assert.rejects(app.listen(a.port), (e) => e.code === 'EADDRINUSE');
  const other = await app.listen(0);
  assert.notEqual(other, a.port);

  await app.close();
  await a.app.close();
});
