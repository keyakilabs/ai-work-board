/**
 * 呼び方は「スレッド」1つ。**`kind` の札「作業依頼」だけは残す。**
 *
 * 画面・取扱説明・README・CLI のヘルプで呼び方が食い違うと、
 * npx で触った人が README と画面で別の言葉を読むことになる
 * （2026-09-24 に「依頼」から改名した）。
 * サーバのエラー文はそのままトーストに出るので、`src/` も見張る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sources() {
  const out = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (/\.(mjs|css|html|md)$/.test(p)) out.push([path.relative(ROOT, p), await fs.readFile(p, 'utf8')]);
    }
  };
  for (const d of ['src', 'web', 'bin', 'templates']) await walk(path.join(ROOT, d));
  out.push(['README.md', await fs.readFile(path.join(ROOT, 'README.md'), 'utf8')]);
  return out;
}

test('呼び方はスレッドで、「依頼」は作業依頼の札だけ', async () => {
  for (const [rel, src] of await sources()) {
    for (const m of src.matchAll(/依頼/g)) {
      const around = src.slice(Math.max(0, m.index - 2), m.index + 2);
      assert.match(around, /作業依頼/,
        `${rel}: 「依頼」が残っている（${src.slice(Math.max(0, m.index - 20), m.index + 20).split('\n')[0]}）`);
    }
  }
});

test('棚のタブは「スレッドを立てる」', async () => {
  // 「出す」は依頼の動詞。スレッドは「立てる」
  const shelf = await fs.readFile(path.join(ROOT, 'web/views/shelf.mjs'), 'utf8');
  assert.match(shelf, /label: 'スレッドを立てる'/, '棚のタブが「スレッドを立てる」になっていない');

  // **README や --help も見る。** shelf.mjs だけ見ていたので、
  // README のキー表が画面に無いラベルを名指ししているのを見落とした
  for (const [rel, src] of await sources()) {
    assert.ok(!/スレッドを出す/.test(src), `${rel}: 「スレッドを出す」が残っている`);
  }
});
