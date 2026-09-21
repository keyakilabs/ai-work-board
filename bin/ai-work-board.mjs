#!/usr/bin/env node
/**
 * ai-work-board — Claude と人が同じ板に書き合う、手元の掲示板・連絡帳。
 *
 * これは Anthropic 公式のツールではない。
 */

import { createServer } from '../src/server.mjs';
import { boardPaths } from '../src/board.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const HELP = `
ai-work-board — Claude と共用の掲示板・連絡帳（Anthropic 公式のツールではありません）

  使い方:  npx ai-work-board [options]

  板は4つの欄でできています:
    相談    Claude が聞きたいこと。画面から答えると板に残ります
    現況    Claude が今なにをしているか
    伝言    あなたが Claude に渡したいこと。次に Claude が見たときに拾います
    決めごと  一度決めたこと。別のセッションからも参照されます

  options:
    -w, --workspace <path>  板を置く場所（既定: 今いるディレクトリ）
    -p, --port <number>     ポート（既定: 3457）
        --demo              自分のファイルを一切読まず、サンプルで画面だけ見る
        --no-open           ブラウザを自動で開かない
        --no-log            「その日開いたか」の記録（日付のみ）を残さない
    -h, --help              これ

  板の正本は <workspace>/.board/ の中の md です。
  サーバは 127.0.0.1 にだけ bind し、外部へ通信しません。
  あなたの ~/.claude/settings.json を書き換えることもありません。
`;

function parseArgs(argv) {
  const o = { workspace: process.cwd(), port: 3457, demo: false, open: true, log: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--demo') o.demo = true;
    else if (a === '--no-open') o.open = false;
    else if (a === '--no-log') o.log = false;
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
if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
  process.stderr.write('ポート番号が不正です\n'); process.exit(2);
}

const app = await createServer(opts);

let port;
try {
  port = await app.listen(opts.port);
} catch (e) {
  if (e?.code === 'EADDRINUSE') {
    process.stderr.write(`ポート ${opts.port} は使われています。--port で別の番号を指定してください\n`);
    process.exit(1);
  }
  throw e;
}

const url = `http://127.0.0.1:${port}`;
process.stdout.write(`
  ai-work-board  ${url}
  ${opts.demo ? 'demo — 自分のファイルは読んでいません' : `板: ${boardPaths(opts.workspace).root}`}
  止めるには Ctrl+C
`);
if (opts.open) openBrowser(url);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await app.close(); process.exit(0); });
}
