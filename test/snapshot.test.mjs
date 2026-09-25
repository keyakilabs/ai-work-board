/**
 * サーバが画面に渡す1枚（`/api/board`）の組み立て。
 *
 * ここを直に見張る理由: 判定そのもの（`groupForBoard` / `isDone`）を
 * `test/board.test.mjs` が見ているが、**それを呼ぶ側の配線は別物**。
 * 実際に、棚を混ぜるのをやめても・`readClosed` の40件制限を戻しても・
 * 内部用の `done` を画面に漏らしても、判定側のテストは全部緑のままだった
 * （2026-09-24 レビュー指摘）。本物のサーバを立てて確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.mjs';
import { boardPaths } from '../src/board.mjs';

/** Board を作り、md を置いてからサーバを立てる。 */
async function boot(files) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-snap-'));
  const p = boardPaths(ws);
  await fs.mkdir(p.items, { recursive: true });
  await fs.mkdir(p.closed, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await fs.writeFile(path.join(p.root, rel), text, 'utf8');
  }
  const app = await createServer({ workspace: ws, port: 0, log: false });
  const port = await app.listen(0);
  return { ws, app, board: async () => (await fetch(`http://127.0.0.1:${port}/api/board`)).json() };
}

const md = (id, over = {}) => {
  const fm = {
    id, kind: 'confirm', title: `件名 ${id}`, priority: 'normal', status: 'open', ...over,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n本文\n`;
};

test('置き場ではなく status で分けて画面に渡す', async () => {
  const c = await boot({
    // items/ に居るのに閉じている紙
    'items/stuck.md': md('stuck', { status: 'closed', closed_at: '2026-09-24T10:00:00+09:00' }),
    // closed/ に居るのに開いている紙
    'closed/revived.md': md('revived', { status: 'open' }),
    'items/alive.md': md('alive', { status: 'open' }),
  });
  try {
    const s = await c.board();
    assert.deepEqual(s.waiting.map((x) => x.id).sort(), ['alive', 'revived'],
      '棚の奥の開いた紙が受付に出ていない');
    assert.deepEqual(s.closed.map((x) => x.id), ['stuck'], '閉じた紙が片付いたに出ていない');
    assert.equal('done' in s, false, '内部用の done が画面まで漏れている');
  } finally { await c.app.close(); }
});

test('棚が40件を超えても、奥の開いた紙を取りこぼさない', async () => {
  // `readClosed` の既定の40件は「画面に出す数」。状態の判定に使うと、
  // 41件目より奥にある開いた紙が受付から消える
  const files = {};
  for (let i = 0; i < 45; i += 1) {
    files[`closed/c${String(i).padStart(2, '0')}.md`] = md(`c${String(i).padStart(2, '0')}`, {
      status: 'closed', closed_at: `2026-09-${String(10 + (i % 15)).padStart(2, '0')}T10:00:00+09:00`,
    });
  }
  // 一番古い日付にして、40件で切られる位置に沈めた開いた紙
  files['closed/deep.md'] = md('deep', { status: 'open', closed_at: '2020-01-01T00:00:00+09:00' });
  const c = await boot(files);
  try {
    const s = await c.board();
    assert.deepEqual(s.waiting.map((x) => x.id), ['deep'], '奥に沈んだ開いた紙が受付に出ていない');
    assert.equal(s.closed.length, 40, '画面に出す件数が40から変わっている');
  } finally { await c.app.close(); }
});

test('closed_at も updated も無い閉じた紙が、どこにも出ないまま消えない', async () => {
  // `status:` の行だけ書き換えた紙。並べる鍵が空だと最後尾に沈み、
  // 40件で切るところで黙って消える
  const files = { 'items/bare.md': md('bare', { status: 'closed', created: '2026-09-24T09:00:00+09:00' }) };
  for (let i = 0; i < 45; i += 1) {
    files[`closed/c${String(i).padStart(2, '0')}.md`] = md(`c${String(i).padStart(2, '0')}`, {
      status: 'closed', closed_at: '2026-09-20T10:00:00+09:00',
    });
  }
  const c = await boot(files);
  try {
    const s = await c.board();
    assert.equal(s.waiting.length, 0, '閉じた紙が受付に出ている');
    assert.ok(s.closed.some((x) => x.id === 'bare'),
      'closed_at の無い閉じた紙が、受付にも片付いたにも出ていない（黙って消えた）');
  } finally { await c.app.close(); }
});

test('同じ id が両方の棚にあったら、items 側を1枚だけ出す', async () => {
  // 移動は「置く」→「消す」の2手なので、間に落ちると両方に残る。
  // 混ぜたあとに2枚並ぶと、カーソルがどちらを指しているか分からなくなる
  const c = await boot({
    'items/dup.md': md('dup', { status: 'open', title: '新しいほう' }),
    'closed/dup.md': md('dup', { status: 'open', title: '古いほう' }),
  });
  try {
    const s = await c.board();
    const all = [...s.waiting, ...s.theirs, ...s.closed];
    assert.equal(all.filter((x) => x.id === 'dup').length, 1, '同じ id が2枚出ている');
    assert.equal(s.waiting[0].title, '新しいほう', 'items 側が採られていない');
  } finally { await c.app.close(); }
});
