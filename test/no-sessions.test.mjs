/**
 * セッション欄はもう無い。
 *
 * 「いま走っている Claude Code」を自動で並べる欄を落とした（2026-09-24 山下の判断）。
 *
 *   > セッション一覧の機能自体なくそう。思想とズレるノイズになってる。
 *
 * 板は「ディスクに在る md がそのまま出ているもの」で、それが読まれる理由だった。
 * 自動で拾った行はファイルの裏付けが無く、そこだけ別の約束で動いていた。
 *
 * 戻ってきたら、静かに約束が2つに割れる（子プロセスも1つ増える）。ここで落とす。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TABS } from '../web/views/shelf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sources(dirs = ['src', 'web', 'bin']) {
  // .mjs だけでなく css も見る。表示を戻すときは CSS から生えることがある
  const out = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (/\.(mjs|css)$/.test(p)) out.push([path.relative(ROOT, p), await fs.readFile(p, 'utf8')]);
    }
  };
  for (const d of dirs) await walk(path.join(ROOT, d));
  return out;
}

test('セッションの欄がどこにも残っていない', async () => {
  assert.deepEqual(TABS.map((t) => t.id), ['tasks', 'theirs', 'closed', 'new']);
  assert.ok(!TABS.some((t) => t.key === 'n'), '`n` のキーが残っている');

  for (const [rel, src] of await sources()) {
    // 小文字の複数形だけを見ると `collectSessions` / `sessionId` がすり抜ける。
    // ラテン文字の `session` をすべて拾う（日本語の「セッション」は正当な文脈で
    // 残っているので、ここには掛からない）
    assert.ok(!/session/i.test(src), `${rel}: セッションを見ている`);
    assert.ok(!src.includes('--resume'), `${rel}: セッションを開くコマンドが残っている`);
    assert.ok(!src.includes('claude agents'), `${rel}: Claude の CLI を起こしている`);
  }
});

test('キーの受け口に、もう無いキーが残っていない', async () => {
  // `TABS` から落とすだけでは、押しても何も起きない死んだ分岐が残る。
  // 見た目は正常なので人の目では気づけない
  const src = await fs.readFile(path.join(ROOT, 'web/app.mjs'), 'utf8');
  const at = src.indexOf("case 't': case 'c':");
  assert.ok(at >= 0, '棚を開くキーの受け口が見つからない（名前を変えたらこのテストも直す）');
  const line = src.slice(at, src.indexOf('\n', at));
  const keys = [...line.matchAll(/case '([a-z])'/g)].map((m) => m[1]);
  assert.deepEqual(keys, TABS.map((t) => t.key), '受け口のキーが TABS と食い違っている');
});

test('セッションを組み立てるファイルが無い', async () => {
  await assert.rejects(() => fs.stat(path.join(ROOT, 'src/sessions.mjs')),
    /ENOENT/, 'src/sessions.mjs が戻っている');
});
