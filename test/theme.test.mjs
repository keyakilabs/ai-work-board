/**
 * 明るさの切り替えが、明暗どちらでも同じ顔ぶれになっているか。
 *
 * 暗い画面の値は `--d-*` に1つだけ置いてあり、それを当てる場所が2つある
 * （OS の設定で暗いとき／画面のスイッチで暗いを選んだとき）。人の目では
 * 片方に1行足し忘れても気づけない — 足りない変数はその場では既定値に
 * 落ちるだけで、色が1つ明るいまま残る、という形でしか出てこない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = await fs.readFile(path.join(root, 'web', 'style.css'), 'utf8');

/** `セレクタ {` から、対応する `}` までの中身を取る。 */
function blockAfter(marker) {
  const at = css.indexOf(marker);
  assert.notEqual(at, -1, `見つからない: ${marker}`);
  const open = css.indexOf('{', at + marker.length - 1);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`閉じていない: ${marker}`);
}

/** そのブロックが当てている `--x: var(--d-x)` の一覧。 */
function mapped(body) {
  return [...body.matchAll(/--([a-z0-9-]+)\s*:\s*var\(\s*--d-([a-z0-9-]+)\s*\)/g)]
    .map(([, to, from]) => ({ to, from }));
}

const byOs = mapped(blockAfter(':root:not([data-theme="light"])'));
const bySwitch = mapped(blockAfter(':root[data-theme="dark"]'));

test('暗い値の置き場は1つで、当てる先の名前と一致している', () => {
  assert.ok(byOs.length >= 20, `当てている数が少なすぎる: ${byOs.length}`);
  for (const { to, from } of byOs) {
    assert.equal(to, from, `名前がずれている: --${to} に --d-${from} を当てている`);
  }
});

test('OSで暗いときと、スイッチで暗いときが、同じ顔ぶれになっている', () => {
  const a = byOs.map((x) => x.to).sort();
  const b = bySwitch.map((x) => x.to).sort();
  assert.deepEqual(b, a, '片方にしかない変数がある（もう片方で色が1つ取り残される）');
});

test('当てている --d-* が、すべて定義されている', () => {
  const defined = new Set([...css.matchAll(/--d-([a-z0-9-]+)\s*:/g)].map(([, n]) => n));
  const missing = byOs.map((x) => x.from).filter((n) => !defined.has(n));
  assert.deepEqual(missing, [], `定義が無い: ${missing.join(', ')}`);
});

test('定義した --d-* が、使われないまま残っていない', () => {
  const defined = [...css.matchAll(/--d-([a-z0-9-]+)\s*:/g)].map(([, n]) => n);
  const used = new Set(byOs.map((x) => x.from));
  const orphans = defined.filter((n) => !used.has(n));
  assert.deepEqual(orphans, [], `どこにも当てていない: ${orphans.join(', ')}`);
});

test('スイッチは OS の設定より優先される（当てる順が後）', () => {
  // 後に書いた方が勝つ。メディアクエリの中は詳細度で勝てないので、
  // 順番が入れ替わると「暗いOSで明るいを選べない」が起きる
  assert.ok(
    css.indexOf(':root[data-theme="dark"]') > css.indexOf(':root:not([data-theme="light"])'),
    'スイッチ用の指定が、OS用より前に来ている',
  );
});
