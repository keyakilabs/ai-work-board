/**
 * 「データは外に出ない」「あなたの環境を書き換えない」を、README の主張では
 * なくテストにしておく。人が後から1行足すだけで崩れる約束なので、機械が
 * 見張る。
 *
 * 当て方を分けているのは、雑な grep だと嘘の警告が出て、やがて誰も直さなく
 * なるため。サーバ側（src/ bin/）は通信そのものを禁じ、ブラウザ側（web/）は
 * 「自分のサーバ以外を指さないこと」だけを見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 書き込み系のAPIを呼んでよいファイル。ここ以外に増えたらテストが落ちる。 */
/*
 * ファイルを書いてよいファイル。
 *
 * `src/setup.mjs` だけは板の外（ワークスペースの CLAUDE.md と
 * CLAUDE.board.md）に書く。板は取扱説明を読ませないと空のままなので、
 * そこまでを道具の責任にした。**書いてよい場所が増えるときは、ここに
 * 名前を足す＝意識して許すこと**を通らせる。
 */
const MAY_WRITE = new Set(['src/board.mjs', 'src/server.mjs', 'src/setup.mjs']);

/**
 * 子プロセスを起こしてよいファイル。
 *
 * `execFile('curl', …)` や `spawn('open', <URL>)` は、このリポジトリの
 * どの通信検査にも掛からずに外へ出られる。`open` に至っては利用者の
 * ブラウザで任意の URL を開ける。実際に2箇所で使っているので、
 * 禁止ではなく「ここだけ」に閉じる。
 */
const MAY_SPAWN = new Set(['src/sessions.mjs', 'bin/ai-work-board.mjs']);

/**
 * 書き込み系のAPI。同期版（*Sync）も必ず拾う。
 *
 * 変異テストで、`fsSync.writeFileSync` を1行足しても検査が素通りし、
 * 実際に settings.json が壊れることが分かった。この板自身が
 * `mkdirSync` / `appendFileSync` を使っているので、次に書く人が同期APIを
 * 選ぶ確率は高い。看板の約束を見張る歯止めなので、ここに穴があると意味がない。
 */
const WRITE_API =
  /\b(writeFile|appendFile|createWriteStream|mkdir|rename|rmdir|unlink|rm|copyFile|truncate)(Sync)?\s*\(/;

/** `open` は読み取りにも使う。書き込みモードで開いているときだけ数える。 */
const WRITE_OPEN = /\bopen(Sync)?\s*\([^)]*,\s*['"][aw]/;

const writesFiles = (code) => WRITE_API.test(code) || WRITE_OPEN.test(code);

async function filesUnder(dirs) {
  const out = [];
  async function walk(dir) {
    let items;
    try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of items) {
      if (d.name === 'node_modules' || d.name === '.git') continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      // html / css を外すと、`@import url(https://…)` や外部フォントの
      // CDN が検査をすり抜ける。CSS に何気なく足されるのはまさにそれ
      else if (/\.(mjs|js|html|css)$/.test(d.name)) out.push(p);
    }
  }
  for (const d of dirs) await walk(path.join(ROOT, d));
  return out;
}

/** 行コメントとブロックコメントを落とし、実行されうる行だけを残す。 */
function codeOnly(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const rel = (f) => path.relative(ROOT, f);

test('実行時の依存パッケージがゼロ', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {}, '実行時依存が増えている');
  // npx で配る以上、任意で入るものも束ねられるものも同じくらい効く面
  assert.deepEqual(pkg.optionalDependencies ?? {}, {}, '任意の依存が増えている');
  assert.deepEqual(pkg.bundledDependencies ?? [], [], '同梱の依存が増えている');
  assert.deepEqual(pkg.peerDependencies ?? {}, {}, 'peer 依存が増えている');
});

test('install のときに何も走らない', async () => {
  // npx はインストールを伴う。preinstall/postinstall は利用者が気づかないまま
  // 任意のコードを走らせられる場所なので、無いことを固定する
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const hooks = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];
  const found = hooks.filter((h) => pkg.scripts?.[h]);
  assert.deepEqual(found, [], `install 時に走るスクリプトがある: ${found.join(', ')}`);
});

test('サーバ側に、外へ通信する手段が一切無い', async () => {
  const banned = [
    [/\bfetch\s*\(/, 'fetch('],
    // node:http は「サーバとして待ち受ける」ために要る。禁じるのは
    // こちらから出て行く呼び出しの方
    [/from\s+['"]node:https['"]/, 'node:https の読み込み'],
    [/\bhttps?\.(request|get)\s*\(/, 'http(s).request / .get'],
    [/\bnet\.connect\b/, 'net.connect'],
    [/\bdgram\b/, 'dgram（UDP）'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  ];

  const bad = [];
  for (const file of await filesUnder(['src', 'bin'])) {
    const code = codeOnly(await fs.readFile(file, 'utf8'));
    for (const [re, name] of banned) if (re.test(code)) bad.push(`${rel(file)}: ${name}`);
  }
  assert.deepEqual(bad, [], `外へ通信しうるコード:\n${bad.join('\n')}`);
});

test('子プロセスを起こせるのは、決めたファイルだけ', async () => {
  // 呼び出し名で探すと `re.exec(s)` のような無関係なものを拾う。
  // 子プロセスは node:child_process を取り込まないと起こせないので、
  // 取り込みそのものを見る
  const imports = /(?:from\s*['"]node:child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)|import\(\s*['"](?:node:)?child_process['"]\s*\))/;
  const bad = [];
  for (const file of await filesUnder(['src', 'bin', 'web'])) {
    const code = codeOnly(await fs.readFile(file, 'utf8'));
    if (imports.test(code) && !MAY_SPAWN.has(rel(file))) bad.push(rel(file));
  }
  assert.deepEqual(bad, [], `子プロセスは外へ出る手段になる:\n${bad.join('\n')}`);
});

test('その検査は、子プロセスの取り込みを本当に見つける', () => {
  // 見張りに穴が空いていないか。過去に同期API（*Sync）を素通りさせた前例がある
  const imports = /(?:from\s*['"]node:child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)|import\(\s*['"](?:node:)?child_process['"]\s*\))/;
  for (const line of [
    "import { execFile } from 'node:child_process';",
    "const { spawn } = require('child_process');",
    "const cp = await import('node:child_process');",
  ]) assert.ok(imports.test(line), `見逃している: ${line}`);
  assert.ok(!imports.test('let m = re.exec(s);'), '正規表現の exec を拾っている');
});

/**
 * SVG の名前空間。
 *
 * `document.createElementNS` に渡す決まった文字列で、取りに行く先ではない
 * （ブラウザはこの URL を読みに行かない）。ここだけは URL の形をしているので、
 * 1件だけ名指しで許す — 「http が出てきたら疑う」の網は緩めない。
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

test('コードのどこにも外部のホストが書かれていない', async () => {
  const bad = [];
  for (const file of await filesUnder(['src', 'bin', 'web'])) {
    const code = codeOnly(await fs.readFile(file, 'utf8')).split(SVG_NS).join('');
    // 127.0.0.1 / localhost 以外の絶対URLは、説明文でなくコード中にあれば疑う
    const m = code.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/gi);
    if (m) bad.push(`${rel(file)}: ${[...new Set(m)].join(', ')}`);
  }
  assert.deepEqual(bad, [], `外部ホストの指定がある:\n${bad.join('\n')}`);
});

test('SVG の名前空間を装って、別のホストを紛れ込ませられない', () => {
  // 上の「1件だけ許す」が、前方一致で緩まないことを確かめる
  const sneaky = 'http://www.w3.org.evil.example/2000/svg';
  assert.ok(!sneaky.startsWith(SVG_NS));
  assert.match(sneaky.split(SVG_NS).join(''), /https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/i);
});

test('ブラウザ側の通信先は、同じサーバの相対パスだけ', async () => {
  const bad = [];
  for (const file of await filesUnder(['web'])) {
    const code = codeOnly(await fs.readFile(file, 'utf8'));
    // fetch と EventSource の第1引数が '/' で始まるリテラルであること
    for (const m of code.matchAll(/(?:fetch|new EventSource)\s*\(\s*([^),]+)/g)) {
      const arg = m[1].trim();
      const relativeLiteral = /^['"`]\//.test(arg);
      const relativeVar = /^(path|url)\b/.test(arg); // api.post(path) の path
      if (!relativeLiteral && !relativeVar) bad.push(`${rel(file)}: ${arg.slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, [], `通信先が相対パスでない:\n${bad.join('\n')}`);
});

test('ファイルを書くのは、書いてよいと決めた2ファイルだけ', async () => {
  const bad = [];
  for (const file of await filesUnder(['src', 'bin', 'web'])) {
    const code = codeOnly(await fs.readFile(file, 'utf8'));
    if (writesFiles(code) && !MAY_WRITE.has(rel(file))) bad.push(rel(file));
  }
  assert.deepEqual(bad, [], `想定外のファイルが書き込みを行っている:\n${bad.join('\n')}`);
});

test('ユーザーの settings.json を書き換えるコードが無い', async () => {
  const bad = [];
  for (const file of await filesUnder(['src', 'bin', 'web'])) {
    const code = codeOnly(await fs.readFile(file, 'utf8'));
    for (const m of code.matchAll(/settings\.json/g)) {
      // 前後200字に書き込みAPIがあれば本物の疑い。--help の説明文は素通しでよい
      const around = code.slice(Math.max(0, m.index - 200), m.index + 200);
      if (writesFiles(around)) bad.push(`${rel(file)} (${m.index})`);
    }
  }
  assert.deepEqual(bad, [], `settings.json を書きうるコードがある:\n${bad.join('\n')}`);
});

test('0.0.0.0 に bind するコードが無い', async () => {
  const bad = [];
  for (const file of await filesUnder(['src', 'bin'])) {
    const code = codeOnly(await fs.readFile(file, 'utf8'));
    if (/0\.0\.0\.0|listen\([^)]*,\s*['"]::['"]/.test(code)) bad.push(rel(file));
  }
  assert.deepEqual(bad, [], '外部に公開しうる bind がある');
});

test('`--help` は「settings.json を書き換えない」と実際に書いている', async () => {
  const help = await fs.readFile(path.join(ROOT, 'bin', 'ai-work-board.mjs'), 'utf8');
  assert.match(help, /settings\.json を書き換える/, '約束が --help から消えている');
  assert.match(help, /公式のツールではありません/, '公式ではない旨が --help から消えている');
});


test('書き込み検査は同期API（*Sync）も拾う', () => {
  // 変異テストで素通りした形を、そのまま検査に掛けて落ちることを確かめる
  const samples = [
    "fsSync.writeFileSync(path.join(os.homedir(),'.claude','settings.json'),'{}')",
    "fs.appendFileSync(p, x)",
    "await fs.writeFile(p, x)",
    "fsSync.mkdirSync(dir, { recursive: true })",
    "fsSync.copyFileSync(a, b)",
    "fh = await fs.open(f, 'w')",
    "fsSync.openSync(f, 'a')",
  ];
  for (const line of samples) {
    assert.ok(writesFiles(line), `拾えていない: ${line}`);
  }

  // 読み取りのための open は書き込みに数えない（数えると嘘の警告になる）
  assert.equal(writesFiles("fh = await fs.open(file, 'r')"), false);
});

test('settings.json の検査も同期APIを拾う', async () => {
  // 近接判定に使う窓の中に同期APIがある場合
  const code = "const f = path.join(home, '.claude', 'settings.json');\nfsSync.writeFileSync(f, '{}');";
  const hit = [...code.matchAll(/settings\.json/g)].some((m) => {
    const around = code.slice(Math.max(0, m.index - 200), m.index + 200);
    return writesFiles(around);
  });
  assert.ok(hit, 'settings.json への同期書き込みを見逃している');
});
