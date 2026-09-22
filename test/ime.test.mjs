/**
 * 変換の確定 Enter で送信しないこと。
 *
 * 日本語を打つと Enter は2つの意味を持つ。変換を確定する Enter と、送信する
 * Enter。前者で送ると、書きかけの見出しが**打っている途中のまま**板に飛ぶ。
 * しかも英語しか打たないと一生気づけない種類の不具合なので、機械で固定する。
 *
 * DOM の無いところで確かめたいので、`addEventListener` だけを持つ張りぼてを
 * 渡す（実行時依存を増やさないため、jsdom のような道具は使わない）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `ui.mjs` は DOM を前提にしているので、enterGuard だけを取り出して読む。 */
function loadEnterGuard() {
  const src = readFileSync(path.join(ROOT, 'web', 'ui.mjs'), 'utf8');
  const at = src.indexOf('export function enterGuard');
  assert.notEqual(at, -1, 'enterGuard が見つからない（名前を変えたらこのテストも直す）');
  const end = src.indexOf('\n}', at) + 2;
  const body = src.slice(at, end).replace('export function', 'function');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return enterGuard;`)();
}

function fakeField() {
  const on = {};
  return {
    addEventListener: (name, fn) => { (on[name] ??= []).push(fn); },
    fire: (name) => (on[name] ?? []).forEach((fn) => fn({})),
  };
}

const enterGuard = loadEnterGuard();

test('変換中の Enter は送信ではない', () => {
  const f = fakeField();
  const composing = enterGuard(f);
  f.fire('compositionstart');
  assert.equal(composing({ key: 'Enter', isComposing: true }), true);
});

test('isComposing が来ない環境でも、keyCode 229 で止める', () => {
  const f = fakeField();
  const composing = enterGuard(f);
  assert.equal(composing({ key: 'Enter', keyCode: 229 }), true);
});

test('確定した直後の Enter も送信ではない', () => {
  const f = fakeField();
  const composing = enterGuard(f);
  f.fire('compositionstart');
  f.fire('compositionend');
  // 環境によって、確定の Enter が composing の外で飛んでくる
  assert.equal(composing({ key: 'Enter' }), true);
});

test('落ち着いてからの Enter は送信になる', async () => {
  const f = fakeField();
  const composing = enterGuard(f);
  f.fire('compositionstart');
  f.fire('compositionend');
  await new Promise((r) => setTimeout(r, 80));   // 見張りの窓（50ms）を越える
  assert.equal(composing({ key: 'Enter' }), false);
});

test('日本語を打っていないときは、最初から送信できる', () => {
  const f = fakeField();
  const composing = enterGuard(f);
  assert.equal(composing({ key: 'Enter' }), false);
});

test('Enter で送る欄は、すべて見張りを通している', () => {
  // 欄を足したときに、ここだけ付け忘れる形で再発するのを防ぐ
  for (const rel of ['web/views/shelf.mjs', 'web/views/inbox.mjs']) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    const handlers = src.split('\n').filter((l) => l.includes("=== 'Enter'"));
    assert.ok(handlers.length > 0, `${rel}: Enter を見ている行が無い`);
    assert.ok(
      src.includes('enterGuard('),
      `${rel}: Enter で送るのに enterGuard を通していない`,
    );
  }
});
