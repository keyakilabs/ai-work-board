/**
 * 板の読み書き。
 *
 * 仕組みは社内で実運用しているデスクをそのまま踏襲している。あちらは実運用で
 * 200件以上を捌いていて、語彙も状態遷移も現場で削られたものなので、
 * こちらで作り直す理由が無い。変えたのは置き場所（`.board/` に
 * 依頼もタスクもまとめる）と、画面の作りだけ。
 *
 *   .board/
 *   ├── items/*.md            依頼（あなた ⇄ Claude）
 *   ├── closed/*.md           片付いた依頼
 *   └── tasks/{inbox,doing,done}/*.md   タスク
 *
 * 依頼は1件1ファイルの Markdown。frontmatter の値は
 * 「JSON として読めれば JSON、読めなければ文字列」。
 * 本文のあとに `<!-- reply {who} {at} -->` 区切りで会話を追記していく。
 */

import fsSync, { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 依頼の種類。desk と同じ4つ。 */
export const KINDS = {
  decision: '判断',
  confirm: '確認',
  action: '作業依頼',
  fyi: '共有',
};

export const PRIORITIES = ['high', 'normal', 'low'];

/**
 * 状態。「いま誰の番か」を状態で持つのがこの仕組みの肝。
 *   open      あなた待ち（Claude が聞いた）
 *   answered  Claude 待ち（あなたが答えた）
 *   closed    完了
 *   withdrawn 取り下げ
 */
export const STATUSES = ['open', 'answered', 'closed', 'withdrawn'];

/** タスクのレーン。desk と同じ3つ。 */
export const LANES = [
  { key: 'doing', label: '着手中' },
  { key: 'inbox', label: '未着手' },
  { key: 'done', label: '完了' },
];

const DONE_DAYS = 7; // 完了レーンは直近ぶんだけ出す

const FM_KEYS = [
  'id', 'title', 'kind', 'priority', 'status', 'project', 'from',
  'created', 'updated', 'due', 'options', 'links', 'answer', 'answered_at', 'closed_at', 'origin',
];

const BOARD_DIR = '.board';
const LEGACY_DIR = path.join('.claude', 'board');

/** 既に古い置き場で使っているなら、そちらを使い続ける。 */
function resolveRoot(workspace) {
  const here = path.join(workspace, BOARD_DIR);
  const legacy = path.join(workspace, LEGACY_DIR);
  // 同期的に見るのは、パスを返す関数を非同期にすると呼び出し側が全部
  // 変わるため。起動時と1リクエストに1回ずつなので、負荷にはならない
  if (!fsSync.existsSync(here) && fsSync.existsSync(legacy)) return legacy;
  return here;
}

/**
 * 板の置き場。
 *
 * 既定は `<workspace>/.board/`。`.claude/` の中ではない。
 *
 * 最初は `.claude/board/` に置いていたが、**Claude Code は `.claude/` を
 * 保護されたパスとして扱い、書き込みを断る**。実測したところ、板を
 * `.claude/board/` に置いた5回の試行で Claude が書けたのは0回、
 * `.board/` に置いた3回では3回とも書けた（どの試行も「書こうとして
 * 断られた」と報告していたので、やる気ではなく置き場所の問題だった）。
 * 板は Claude が書いてくれて初めて板になるので、ここは譲れない。
 *
 * すでに `.claude/board/` で使っている板は、そのまま読み続ける。
 * 勝手に動かすと、中身を見失ったように見えるため。
 */
export function boardPaths(workspace) {
  const root = resolveRoot(workspace);
  const tasks = path.join(root, 'tasks');
  return {
    root,
    legacy: root.endsWith(path.join('.claude', 'board')),
    items: path.join(root, 'items'),
    closed: path.join(root, 'closed'),
    tasks,
    lanes: Object.fromEntries(LANES.map(({ key }) => [key, path.join(tasks, key)])),
  };
}

export async function ensureBoard(workspace) {
  const p = boardPaths(workspace);
  for (const dir of [p.items, p.closed, ...Object.values(p.lanes)]) {
    await fs.mkdir(dir, { recursive: true });
  }

  // 板の中身が外を指すリンクだと、以後の書き込みが全部外へ出る。
  // 隣は `~/.claude/settings.json`（hooks ＝ 任意コード実行）なので確かめる
  const root = await fs.realpath(p.root);
  for (const dir of [p.items, p.closed, ...Object.values(p.lanes)]) {
    const real = await fs.realpath(dir);
    if (!(real === root || real.startsWith(root + path.sep))) {
      throw new Error(`${path.relative(p.root, dir)} が板の外（${real}）を指しています`);
    }
  }
  return p;
}

/** ローカル時刻を ISO 8601 のオフセット付きで返す。人が読む板なので UTC にしない。 */
export function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    + `T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
    + `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/* ── frontmatter ───────────────────────────── */

function parseValue(raw) {
  const v = raw.trim();
  if (v === '') return '';
  try { return JSON.parse(v); } catch { return v; }
}

function formatValue(v) {
  if (v === undefined || v === null || v === '') return '';
  if (Array.isArray(v)) return JSON.stringify(v);
  const s = String(v);
  // 改行・前後空白を含む、または JSON として別の値に読めてしまう場合だけ引用する
  let misread = false;
  try { misread = typeof JSON.parse(s) !== 'string' || s.startsWith('"'); } catch { /* 文字列 */ }
  return /[\n\r]/.test(s) || s !== s.trim() || misread ? JSON.stringify(s) : s;
}

const REPLY_SPLIT = /^<!-- reply (\S+) (\S+) -->[ \t]*$/m;

/**
 * 依頼1件を読む。壊れていても例外にしない。
 * 板は人も Claude も手で書くので、1枚壊れただけで板が落ちるのは最悪の壊れ方。
 */
export function parseItem(text, id) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { id, broken: true, brokenWhy: 'frontmatter がありません', replies: [], options: [], links: [] };

  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0 || line.trimStart().startsWith('#')) continue;
    meta[line.slice(0, i).trim()] = parseValue(line.slice(i + 1));
  }

  const parts = m[2].split(new RegExp(REPLY_SPLIT.source, 'm'));
  const replies = [];
  for (let i = 1; i < parts.length; i += 3) {
    replies.push({ who: parts[i], at: parts[i + 1], text: (parts[i + 2] || '').trim() });
  }

  const kind = KINDS[meta.kind] ? meta.kind : null;
  const title = typeof meta.title === 'string' && meta.title ? meta.title : null;

  return {
    id: meta.id || id,
    kind,
    kindLabel: kind ? KINDS[kind] : null,
    title,
    priority: PRIORITIES.includes(meta.priority) ? meta.priority : 'normal',
    status: STATUSES.includes(meta.status) ? meta.status : 'open',
    project: meta.project || '',
    from: meta.from || '',
    created: meta.created || '',
    updated: meta.updated || '',
    due: meta.due || '',
    options: Array.isArray(meta.options) ? meta.options : [],
    links: Array.isArray(meta.links) ? meta.links : [],
    answer: meta.answer ?? '',
    answered_at: meta.answered_at || '',
    closed_at: meta.closed_at || '',
    origin: meta.origin || '',
    body: parts[0].trim(),
    replies,
    broken: !kind || !title,
    brokenWhy: !kind ? `kind が無いか未知（${JSON.stringify(meta.kind ?? null)}）`
      : !title ? 'title がありません' : '',
    raw: meta,
  };
}

/** 依頼1件を md に戻す。会話はそのまま積み直す。 */
export function stringifyItem(item) {
  const lines = ['---'];
  for (const k of FM_KEYS) {
    if (!(k in item)) continue;
    const v = formatValue(item[k]);
    lines.push(v === '' ? `${k}:` : `${k}: ${v}`);
  }
  lines.push('---', '');

  let out = `${lines.join('\n')}\n${item.body ?? ''}\n`;
  for (const r of item.replies ?? []) {
    out += `\n<!-- reply ${r.who} ${r.at} -->\n\n${r.text}\n`;
  }
  return out;
}

/* ── 書き込み ───────────────────────────────── */

/** 書く直前に、その場所が本当に板の中かを実体で確かめる。 */
/**
 * そのファイルを板の中身として読んでよいか。
 *
 * 書き込みだけでなく**読み取りにも**要る。板はファイルを置ける者なら誰でも
 * 書けると想定しているので、`items/x.md -> ~/.ssh/id_rsa` のような
 * シンボリックリンクを置かれると、画面が板の外の中身を映してしまう。
 * 文字列の突き合わせでは見抜けないので realpath で見る。
 */
export async function mayReadFromBoard(workspace, file) {
  const real = await fs.realpath(file).catch(() => null);
  // 実体が無いなら、読んでも何も出ない。「無い」は「無い」として
  // 返させたいので、ここで弾くと 404 が 400 に化けて理由が分からなくなる
  if (!real) return true;
  const root = await fs.realpath(boardPaths(workspace).root).catch(() => null);
  if (!root) return false;
  return real === root || real.startsWith(root + path.sep);
}

async function assertInsideBoard(workspace, file) {
  const root = await fs.realpath(boardPaths(workspace).root).catch(() => null);
  if (!root) throw new Error('板の場所が確かめられない');
  const inBoard = (p) => p === root || p.startsWith(root + path.sep);

  const parent = await fs.realpath(path.dirname(file)).catch(() => null);
  if (!parent || !inBoard(parent)) throw new Error('板の外に書こうとしている');

  const real = await fs.realpath(file).catch(() => null);
  if (real && !inBoard(real)) throw new Error('板の外を指すファイルには書けない');
}

/**
 * 書き込みは一時ファイル + rename。
 * 板は並行セッションが同時に触る前提なので、途中まで書けたファイルを読ませない。
 */
export async function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/**
 * ファイル名に使う部分は ASCII だけにする。
 * 日本語をそのまま入れると、macOS と Linux と git でユニコード正規化が
 * 食い違い、同じ名前のファイルが2つに見える事故になる。
 */
function slug(s, max = 40) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
}

export function newId(title, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const head = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const tail = slug(title);
  return tail ? `${head}-${tail}` : head;
}

async function taken(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

/**
 * id は板の中で一意にする。
 *
 * 見出しが日本語だと名前は日時だけになるので、同じ秒に2件書くと衝突する。
 * さらに closed へ移した直後は items の名前が空くので、そこだけ見ると
 * 次の1件が closed 側を上書きしてしまう。両方を見る。
 */
async function reserve(p, base) {
  for (let i = 0; i < 200; i += 1) {
    const id = i === 0 ? base : `${base}-${i + 1}`;
    if (await taken(path.join(p.closed, `${id}.md`))) continue;
    const file = path.join(p.items, `${id}.md`);
    try {
      const fh = await fs.open(file, 'wx');
      await fh.close();
      return { id, file };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('同じ名前の依頼が多すぎて置き場所を決められない');
}

/* ── 読み取り ───────────────────────────────── */

async function readDir(dir, where) {
  let names;
  try { names = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const id = name.replace(/\.md$/, '');
    try {
      out.push({ ...parseItem(await fs.readFile(path.join(dir, name), 'utf8'), id), where });
    } catch {
      out.push({ id, where, broken: true, brokenWhy: 'ファイルが読めない', replies: [], options: [], links: [] });
    }
  }
  return out;
}

const PRI_RANK = { high: 0, normal: 1, low: 2 };
const oldestFirst = (a, b) => String(turnedAt(a)).localeCompare(String(turnedAt(b)));

/**
 * 最後に発言したのは誰か。
 *
 * ここが「いま誰の番か」の正本。`status` は Claude が書き換えるのを
 * 忘れることがあるが、**会話の最後の行は嘘をつけない**。
 */
export function lastSpeaker(item) {
  const last = (item.replies ?? []).at(-1);
  return last ? last.who : null;
}

/** いつからその人の番になったか。並び順は「待たせている時間」で決める。 */
export function turnedAt(item) {
  return (item.replies ?? []).at(-1)?.at || item.created || '';
}

/**
 * あなたの番か。
 *
 * 決め手は「最後に話したのが誰か」。Claude が返信を積んだ時点で
 * 人の番に戻る — でないと、人が答えて Claude が返しても、その紙は
 * ずっと「Claude の番」に居座り、受付で待っている人には永久に届かない。
 * `status` に頼ると、Claude が1行書き換え忘れるだけで会話が止まる。
 */
export function isYourTurn(item) {
  const who = lastSpeaker(item);
  if (who) return who === 'claude';
  return item.status === 'open';
}

/** 優先度 → 起票順。desk の既定の並び。 */
export function byPriorityThenAge(a, b) {
  return (PRI_RANK[a.priority] ?? 1) - (PRI_RANK[b.priority] ?? 1) || oldestFirst(a, b);
}

export async function readItems(workspace) {
  const p = boardPaths(workspace);
  return readDir(p.items, 'items');
}

export async function readClosed(workspace, limit = 40) {
  const p = boardPaths(workspace);
  return (await readDir(p.closed, 'closed'))
    .filter((e) => !e.broken)
    .sort((a, b) => String(b.closed_at || b.updated || '').localeCompare(String(a.closed_at || a.updated || '')))
    .slice(0, limit);
}

/** 画面が使う形に束ねる。 */
export function groupForBoard(items) {
  const broken = items.filter((e) => e.broken);
  const ok = items.filter((e) => !e.broken);
  return {
    // あなた待ち。優先度が高いもの・待たせているものから
    waiting: ok.filter(isYourTurn).sort(byPriorityThenAge),
    // Claude の番。あなたが答えたので、次は向こうが動く
    theirs: ok.filter((e) => !isYourTurn(e)).sort(byPriorityThenAge),
    broken,
  };
}

/* ── タスク ───────────────────────────────── */

function taskTitle(text, name) {
  const head = String(text).match(/^#\s+(.+)$/m);
  return (head ? head[1] : name)
    .replace(/\s*[（(]\d{4}-\d{2}-\d{2}\s*起票[）)]\s*$/, '')
    .trim();
}

/** 本文の「いまどこまで」を拾う。落ちても再開できるようにするための行。 */
function nowLine(text) {
  const m = String(text).match(/\*\*いまどこまで\*\*\s*[:：]?\s*(.+)/);
  return m ? m[1].trim() : '';
}

export async function readTasks(workspace) {
  const p = boardPaths(workspace);
  const since = Date.now() - DONE_DAYS * 86400 * 1000;

  const lanes = [];
  for (const { key, label } of LANES) {
    const dir = p.lanes[key];
    let names = [];
    try { names = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')); } catch { /* 無ければ空 */ }

    let tasks = [];
    for (const name of names) {
      const full = path.join(dir, name);
      let text = '';
      let updated = '';
      try {
        text = (await fs.readFile(full, 'utf8')).slice(0, 8000);
        updated = new Date((await fs.stat(full)).mtimeMs).toISOString();
      } catch { continue; }
      const id = name.replace(/\.md$/, '');
      tasks.push({
        id,
        lane: key,
        title: taskTitle(text, id),
        now: nowLine(text),
        // desk 由来の id は `YYYYMMDD-<PJ名>-<見出し>`。こちらで作る id は
        // `YYYYMMDD-HHMMSS-<見出し>` なので、そのまま拾うと**時刻**が
        // プロジェクト札として画面に出る（「104829」等）。6桁の数字は外す
        project: id.match(/^\d{8}-(?!\d{6}(?:-|$))([a-z0-9]+)-/)?.[1] ?? '',
        updated,
      });
    }
    if (key === 'done') tasks = tasks.filter((t) => new Date(t.updated).getTime() >= since);
    tasks.sort((a, b) => b.updated.localeCompare(a.updated));
    lanes.push({ key, label, tasks });
  }
  return { lanes, doneDays: DONE_DAYS };
}

export async function readTask(workspace, lane, id) {
  const p = boardPaths(workspace);
  if (!p.lanes[lane]) throw new Error('そのレーンはありません');
  const file = path.join(p.lanes[lane], `${id}.md`);
  if (!await mayReadFromBoard(workspace, file)) throw new Error('板の外を指すファイルは読めない');
  return { path: file, text: await fs.readFile(file, 'utf8') };
}

/** タスクをレーン間で動かす。 */
export async function moveTask(workspace, id, from, to) {
  const p = await ensureBoard(workspace);
  if (!p.lanes[from] || !p.lanes[to]) throw new Error('そのレーンはありません');

  // 同じレーンへ動かすと、書いた先と消す元が同じファイルになり、
  // 書いた直後に自分で消してタスクが無言で消える。画面は同じレーンを
  // 出さないが、/api/task-move は直接叩ける口なので、ここで止める
  if (from === to) return { id, lane: to, file: path.join(p.lanes[to], `${id}.md`) };

  const src = path.join(p.lanes[from], `${id}.md`);
  const dest = path.join(p.lanes[to], `${id}.md`);
  await assertInsideBoard(workspace, dest);
  const text = await fs.readFile(src, 'utf8');
  // 移動先に同じ名前があるなら、それは別のタスク。黙って踏み潰さない
  // （Claude が move ではなく copy をした板では起こりうる）
  try {
    await fs.access(dest);
    const e = new Error('移動先に同じ名前のタスクがあります');
    e.status = 409;
    throw e;
  } catch (err) {
    if (err.status === 409) throw err;
    if (err.code !== 'ENOENT') throw err;
  }
  await writeFileAtomic(dest, text);
  await fs.rm(src, { force: true });
  return { id, lane: to, file: dest };
}

export async function createTask(workspace, { title, body = '', lane = 'inbox' }) {
  if (!title || !String(title).trim()) throw new Error('見出しは必須');
  const p = await ensureBoard(workspace);
  if (!p.lanes[lane]) throw new Error('そのレーンはありません');

  const id = newId(title);
  const file = path.join(p.lanes[lane], `${id}.md`);
  await assertInsideBoard(workspace, file);
  const text = `# ${String(title).trim()}\n\n${body || '**いまどこまで**: まだ着手していない'}\n`;
  await writeFileAtomic(file, text);
  return { id, lane, file };
}

/* ── 依頼の操作 ───────────────────────────── */

/**
 * 依頼を立てる。
 *
 * `status` の既定は `open`（あなた待ち）。Claude が聞いてくる形がこれ。
 * 逆に**あなたから Claude に出す依頼**は、出した時点で向こうの番なので
 * `answered` で立てる。自分が出したものを自分が待つ形にしない。
 */
export async function createItem(workspace, {
  kind = 'confirm', title, body = '', priority = 'normal',
  project = '', from = '', options = [], links = [], due = '', origin = '',
  status = 'open',
}) {
  if (!KINDS[kind]) throw new Error(`未知の kind: ${kind}`);
  if (!title || !String(title).trim()) throw new Error('title は必須');

  const p = await ensureBoard(workspace);
  const { id, file } = await reserve(p, newId(title));
  await assertInsideBoard(workspace, file);

  const now = stamp();
  const item = {
    id, title: String(title).trim(), kind,
    priority: PRIORITIES.includes(priority) ? priority : 'normal',
    status: STATUSES.includes(status) ? status : 'open',
    project, from, created: now, updated: now, due,
    options: Array.isArray(options) ? options : [],
    links: Array.isArray(links) ? links : [],
    origin, body, replies: [],
  };
  await writeFileAtomic(file, stringifyItem(item));
  return { id, file };
}

async function loadItem(workspace, id) {
  const p = boardPaths(workspace);
  for (const [dir, where] of [[p.items, 'items'], [p.closed, 'closed']]) {
    const file = path.join(dir, `${id}.md`);
    try {
      return { file, where, item: { ...parseItem(await fs.readFile(file, 'utf8'), id), where } };
    } catch { /* 次を探す */ }
  }
  const e = new Error('その依頼は見つかりません');
  e.code = 'ENOENT';
  throw e;
}

async function saveTo(workspace, item, dir, id) {
  const dest = path.join(dir, `${id}.md`);
  await assertInsideBoard(workspace, dest);
  await writeFileAtomic(dest, stringifyItem(item));
  return dest;
}

/**
 * 答える。
 *
 * 答えたら「Claude 待ち（answered）」になる。ここで完了にはしない —
 * 答えを受けて Claude が動き、それを見てから完了にするのがこの仕組みの形。
 * `close` を立てれば、答えると同時に完了にできる（desk の「この回答で完了にする」）。
 */
export async function answerItem(workspace, id, answer, { close = false, who = 'you' } = {}) {
  const p = await ensureBoard(workspace);
  const { file, item } = await loadItem(workspace, id);
  if (item.where === 'closed') throw new Error('片付いた依頼には答えられません');

  const now = stamp();
  item.replies = [...(item.replies ?? []), { who, at: now, text: String(answer ?? '') }];
  item.answer = String(answer ?? '');
  item.answered_at = now;
  item.updated = now;
  item.status = close ? 'closed' : 'answered';
  if (close) item.closed_at = now;

  const dest = await saveTo(workspace, item, close ? p.closed : p.items, id);
  if (dest !== file) await fs.rm(file, { force: true });
  return { id, status: item.status, file: dest };
}

/** 完了にする。 */
export async function closeItem(workspace, id, { withdrawn = false } = {}) {
  const p = await ensureBoard(workspace);
  const { file, item } = await loadItem(workspace, id);
  const now = stamp();
  item.status = withdrawn ? 'withdrawn' : 'closed';
  item.closed_at = now;
  item.updated = now;
  const dest = await saveTo(workspace, item, p.closed, id);
  if (dest !== file) await fs.rm(file, { force: true });
  return { id, status: item.status, file: dest };
}

/**
 * 板に戻す。
 *
 * 押し間違いを戻せることは、この板の約束の中核。答えを消して
 * 「あなた待ち」に戻し、会話の最後の1件も取り下げる。
 */
export async function reopenItem(workspace, id) {
  const p = await ensureBoard(workspace);
  const { file, item } = await loadItem(workspace, id);

  const last = (item.replies ?? [])[item.replies.length - 1];
  if (last && last.who !== 'claude') item.replies = item.replies.slice(0, -1);

  delete item.answer;
  delete item.answered_at;
  delete item.closed_at;
  item.status = 'open';
  item.updated = stamp();

  const dest = await saveTo(workspace, item, p.items, id);
  if (dest !== file) await fs.rm(file, { force: true });
  return { id, status: 'open', file: dest };
}
