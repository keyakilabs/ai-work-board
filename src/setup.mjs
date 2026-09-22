/**
 * 初回の下ごしらえ。
 *
 * 板は Claude が書いてくれて初めて板になる。実測すると、取扱説明を
 * 読ませていないセッションは板の存在すら知らない（そして画面は永遠に空のまま）。
 * だから「立ち上げたら使えるようになっている」ところまでを道具の責任にする。
 *
 * ただしこれは **板の外に書く** 唯一の処理なので、次の3つを守る。
 *   1. 何をしたかを必ず画面に出す（黙って人のファイルを触らない）
 *   2. 既にあるものは上書きしない。足すのは1行だけ
 *   3. `--no-setup` で完全に止められる
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'templates', 'CLAUDE.board.md');

export const GUIDE_NAME = 'CLAUDE.board.md';
export const IMPORT_LINE = `@${GUIDE_NAME}`;

const exists = (p) => fs.access(p).then(() => true, () => false);

/**
 * 取扱説明を置いて、CLAUDE.md から読み込ませる。
 *
 * 何もする必要がなければ何もしない（2回目以降は毎回ここを通るので、
 * 起動のたびに同じ行が増えていくようなことがあってはならない）。
 */
export async function ensureInstructions(workspace) {
  const done = [];
  const guide = path.join(workspace, GUIDE_NAME);
  const claudeMd = path.join(workspace, 'CLAUDE.md');

  if (!await exists(guide)) {
    await fs.writeFile(guide, await fs.readFile(TEMPLATE, 'utf8'));
    done.push({ what: 'created', file: GUIDE_NAME });
  }

  const had = await exists(claudeMd);
  const text = had ? await fs.readFile(claudeMd, 'utf8') : '';

  // 既に読み込まれているなら触らない。`@CLAUDE.board.md` が行として
  // 出てくるかだけを見る（本文中で名前に言及しているだけの行は拾わない）
  const linked = text.split('\n').some((l) => l.trim() === IMPORT_LINE);
  if (!linked) {
    const head = had && text.trim() ? `${text.replace(/\s*$/, '')}\n\n` : '';
    await fs.writeFile(claudeMd, `${head}${IMPORT_LINE}\n`);
    done.push({ what: had ? 'appended' : 'created', file: 'CLAUDE.md' });
  }

  return done;
}

/** 画面に出す文面。何もしていないときは何も出さない。 */
export function describe(done) {
  if (!done.length) return '';
  const say = done.map((d) => (d.what === 'created'
    ? `  ${d.file} を作りました`
    : `  CLAUDE.md に ${IMPORT_LINE} を1行足しました`));
  return `\n  はじめての場所なので、Claude が板を使えるようにしました:\n${say.join('\n')}\n  （不要なら --no-setup。足した行を消せば元に戻ります）\n`;
}
