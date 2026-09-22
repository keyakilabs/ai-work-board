/**
 * 初回の下ごしらえ。
 *
 * ここは**人のファイルに書く唯一の場所**なので、挙動を全部固定する。
 * とくに「起動のたびに同じ行が増える」「手で直したものを上書きする」は、
 * 一度でも起きると道具ごと信用されなくなる。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureInstructions, describe as say, GUIDE_NAME, IMPORT_LINE } from '../src/setup.mjs';

const ws = () => fs.mkdtemp(path.join(os.tmpdir(), 'awb-setup-'));
const read = (d, f) => fs.readFile(path.join(d, f), 'utf8');

test('何も無い場所では、取扱説明を置いて CLAUDE.md から読ませる', async () => {
  const dir = await ws();
  const done = await ensureInstructions(dir);

  const guide = await read(dir, GUIDE_NAME);
  assert.match(guide, /\.board\//, '取扱説明の中身が入っていない');
  assert.ok(!guide.includes('.claude/board/'), '古い置き場の説明が混ざっている');

  assert.equal((await read(dir, 'CLAUDE.md')).trim(), IMPORT_LINE);
  assert.deepEqual(done.map((d) => d.file).sort(), ['CLAUDE.board.md', 'CLAUDE.md']);
  assert.match(say(done), /CLAUDE\.board\.md を作りました/);
});

test('2回目は何もしない（起動のたびに行が増えない）', async () => {
  const dir = await ws();
  await ensureInstructions(dir);
  const before = await read(dir, 'CLAUDE.md');

  const again = await ensureInstructions(dir);
  assert.deepEqual(again, [], '2回目に何かしている');
  assert.equal(await read(dir, 'CLAUDE.md'), before);
  assert.equal(say(again), '', '何もしていないのに画面に出している');
});

test('すでにある CLAUDE.md は消さず、1行だけ足す', async () => {
  const dir = await ws();
  const mine = '# うちの決まり\n\n- 日本語で書く\n- main に直接 push しない\n';
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), mine);

  await ensureInstructions(dir);
  const after = await read(dir, 'CLAUDE.md');
  assert.ok(after.startsWith(mine.trimEnd()), '元の中身が変わっている');
  assert.equal(after.trimEnd().split('\n').at(-1), IMPORT_LINE);
  // 足したのは空行と1行だけ
  assert.equal(after.trimEnd().split('\n').length, mine.trimEnd().split('\n').length + 2);
});

test('手で直した取扱説明を上書きしない', async () => {
  const dir = await ws();
  const mine = '# うちの板の使い方（手で直したもの）\n';
  await fs.writeFile(path.join(dir, GUIDE_NAME), mine);

  const done = await ensureInstructions(dir);
  assert.equal(await read(dir, GUIDE_NAME), mine, '手で直したものを上書きした');
  assert.deepEqual(done.map((d) => d.file), ['CLAUDE.md']);
});

test('すでに読み込ませてあるなら、重ねて足さない', async () => {
  const dir = await ws();
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), `# 決まり\n\n${IMPORT_LINE}\n\n## つづき\n`);
  await fs.writeFile(path.join(dir, GUIDE_NAME), 'x');

  assert.deepEqual(await ensureInstructions(dir), []);
});

test('名前に触れているだけの行は「読み込み済み」と見なさない', async () => {
  const dir = await ws();
  // 説明文の中で名前を書いているだけ。これを読み込みと誤解すると、
  // 取扱説明が永久に読まれないまま板が空になる
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), '板の説明は CLAUDE.board.md にある（@CLAUDE.board.md で読める）\n');
  const done = await ensureInstructions(dir);
  assert.deepEqual(done.map((d) => d.file), ['CLAUDE.board.md', 'CLAUDE.md']);
  assert.equal((await read(dir, 'CLAUDE.md')).trimEnd().split('\n').at(-1), IMPORT_LINE);
});

test('板の外に書くのは、この2ファイルだけ', async () => {
  const dir = await ws();
  await ensureInstructions(dir);
  const made = await fs.readdir(dir);
  assert.deepEqual(made.sort(), ['CLAUDE.board.md', 'CLAUDE.md']);
});
