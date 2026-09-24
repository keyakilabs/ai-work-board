/**
 * 棚（一覧）の数字。
 *
 * 数字は「見たら手が動く」ものだけ出す。片付いた数は見ても何もしないので
 * 出さない（2026-09-24 山下の判断）。
 *
 *   > 認知負荷を減らしたいのに、これは不要
 *
 * 出す / 出さないは `TABS` の `noCount` 一箇所で決まる。棚の札と一覧のタブ帯が
 * その一箇所を見ていること、そして**札が独自に数えても `noCount` が勝つ**ことを
 * 見張る（後者が無いと、札に `count` を1行足すだけで数字が戻る）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TABS } from '../web/views/shelf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');

/** 見張る範囲を切り出す。境目が消えていたら（-1）黙って全文になるので、そこで落とす。 */
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  assert.ok(a >= 0, `見張りの始まりが無い: ${from}`);
  assert.ok(b >= 0, `見張りの終わりが無い: ${to}`);
  assert.ok(a < b, `見張りの範囲が逆: ${from} / ${to}`);
  return src.slice(a, b);
}

/** `{ id: '<id>', … }` を、対応する閉じ括弧まで取り出す。 */
function rackEntry(src, id) {
  const at = src.indexOf(`id: '${id}'`);
  assert.ok(at >= 0, `棚に ${id} の札が無い`);
  const open = src.lastIndexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open, i + 1); }
  }
  assert.fail(`${id} の札が閉じていない`);
}

test('「片付いた」に件数を出さない', async () => {
  const closed = TABS.find((t) => t.id === 'closed');
  assert.ok(closed, '「片付いた」のタブが無い');
  assert.equal(closed.noCount, true, '「片付いた」に件数が戻っている');

  const app = await read('web/app.mjs');

  // 棚の札。`noCount` が最後の判断で、独自の count より強いこと
  const item = slice(app, 'function rackItem(', 'function rackSig(');
  assert.match(item, /tab\?\.noCount \? null/, '棚の札で noCount が最後の判断になっていない');

  // 再描画の鍵も同じ判断でないと、数字が変わらないのに描き直す／その逆が起きる
  const sig = slice(app, 'function rackSig(', 'function renderRack(');
  assert.match(sig, /tab\?\.noCount \? null/, '再描画の鍵が noCount を見ていない');

  // 一覧のタブ帯
  const strip = slice(await read('web/views/shelf.mjs'), 'export function shelf(', 'export function help(');
  assert.match(strip, /t\.noCount \? '' :/, '一覧のタブが noCount を見ていない');

  // 札に独自の count を足す、という一番ありそうな戻し方を塞ぐ
  const rack = slice(app, 'const RACK = [', 'function rackItem(');
  assert.ok(!/count/.test(rackEntry(rack, 'closed')), '「片付いた」の札が独自に数えている');
});
