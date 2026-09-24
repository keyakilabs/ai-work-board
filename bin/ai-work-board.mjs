#!/usr/bin/env node
/**
 * ai-work-board — Claude と人が同じ板に書き合う、手元の掲示板・連絡帳。
 *
 * これは Anthropic 公式のツールではない。
 */

import { createServer } from '../src/server.mjs';
import { boardPaths } from '../src/board.mjs';
import { ensureInstructions, describe } from '../src/setup.mjs';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 版を名乗る。
 *
 * npx は同じ指定なら取り直さずキャッシュを使うので、直したのに直らない、が
 * 起きる。そのとき「いま動いているのが何か」が画面に出ていないと、
 * 直した側も使う側も原因を追えない。
 */
const VERSION = await fs.readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8',
).then((t) => JSON.parse(t).version).catch(() => '?');

const HELP = `
ai-work-board — Claude と共用の掲示板・連絡帳（Anthropic 公式のツールではありません）

  版が古いまま動いていないか: 起動時に出る番号と、GitHub の package.json を見比べてください
  （npx はキャッシュを使い回すので、取り直すには #<コミット> を付けます）

  使い方:  npx ai-work-board [options]

  Claude からのスレッドが1件ずつ受付に出ます。読んで、その場で答えると次へ進みます。
  スレッド・タスク・片付いたものは、全部この板の中にあります。

  options:
    -w, --workspace <path>  板を置く場所（既定: 今いるディレクトリ）
    -p, --port <number>     ポート（既定: 3457 から空いている番号を自動で探す）
        --demo              自分のファイルを一切読まず、サンプルで画面だけ見る
        --no-open           ブラウザを自動で開かない
        --no-setup          CLAUDE.board.md の設置と CLAUDE.md への1行追記をしない
        --no-log            「その日開いたか」の記録（日付のみ）を残さない
    -h, --help              これ

  板の正本は <workspace>/.board/ の中の md です。
  はじめての場所では CLAUDE.board.md を置き、CLAUDE.md に @CLAUDE.board.md を
  1行足します（これをしないと Claude は板の存在を知らず、板は空のままです）。
  サーバは 127.0.0.1 にだけ bind し、外部へ通信しません。
  あなたの ~/.claude/settings.json を書き換えることもありません。
`;

function parseArgs(argv) {
  const o = {
    workspace: process.cwd(), port: null, demo: false,
    open: true, log: true, setup: true, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--demo') o.demo = true;
    else if (a === '--no-open') o.open = false;
    else if (a === '--no-log') o.log = false;
    else if (a === '--no-setup') o.setup = false;
    else if (a === '-p' || a === '--port') o.port = Number(argv[++i]);
    else if (a === '-w' || a === '--workspace') o.workspace = path.resolve(String(argv[++i] ?? '.'));
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a.startsWith('--workspace=')) o.workspace = path.resolve(a.slice(12));
    else { process.stderr.write(`知らないオプション: ${a}\n${HELP}`); process.exit(2); }
  }
  return o;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const p = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    // spawn は後から error を投げてくる。拾わないとプロセスごと落ちる
    p.on('error', () => {});
    p.unref();
  } catch { /* 開けなくても板は動く */ }
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { process.stdout.write(HELP); process.exit(0); }
if (opts.port !== null && (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)) {
  process.stderr.write('ポート番号が不正です\n'); process.exit(2);
}

const DEFAULT_PORT = 3457;
const PORT_TRIES = 20;

const app = await createServer({ ...opts, port: opts.port ?? DEFAULT_PORT });

/**
 * ポートは自分で探す。
 *
 * 同じマシンで複数のプロジェクトに板を立てるのはふつうのことなので、
 * 2つ目で「使われています」と言って止まるのは道具側の怠慢。
 * `--port` で明示されたときだけは、そこが空くまで待たずに失敗させる
 * （指定した番号で開くつもりの人に、黙って別の番号を渡さない）。
 */
let port;
let tryPort = opts.port ?? DEFAULT_PORT;
for (let i = 0; ; i += 1) {
  try {
    port = await app.listen(tryPort);
    break;
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e;
    if (opts.port !== null) {
      process.stderr.write(`ポート ${opts.port} は使われています。--port を外すと空いている番号を自動で探します\n`);
      process.exit(1);
    }
    if (i >= PORT_TRIES) {
      process.stderr.write(`${DEFAULT_PORT} から ${DEFAULT_PORT + PORT_TRIES} まで全部使われています。--port で番号を指定してください\n`);
      process.exit(1);
    }
    tryPort = DEFAULT_PORT + i + 1;
  }
}

// 板が使えるようになるところまでが道具の責任。demo は人のファイルを触らない
let setupNote = '';
if (opts.setup && !opts.demo) {
  try {
    setupNote = describe(await ensureInstructions(opts.workspace));
  } catch (e) {
    setupNote = `\n  CLAUDE.md の用意ができませんでした（${e.message}）。手で入れてください\n`;
  }
}

const url = `http://127.0.0.1:${port}`;
process.stdout.write(`
  ai-work-board ${VERSION}  ${url}
  ${opts.demo ? 'demo — 自分のファイルは読んでいません' : `板: ${boardPaths(opts.workspace).root}`}
${setupNote}  止めるには Ctrl+C
`);
if (opts.open) openBrowser(url);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await app.close(); process.exit(0); });
}
