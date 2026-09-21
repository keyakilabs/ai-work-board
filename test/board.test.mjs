import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseItem, stringifyItem, createItem, readItems, readClosed, groupForBoard,
  answerItem, closeItem, reopenItem, createTask, moveTask, readTasks,
  newId, stamp, boardPaths, byPriorityThenAge, KINDS, STATUSES,
} from '../src/board.mjs';

async function ws() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'awb-test-'));
}

/* ── frontmatter と会話 ───────────────────── */

test('frontmatter が往復する', () => {
  const md = '---\nid: x\nkind: decision\ntitle: どっち\npriority: high\nstatus: open\n'
    + 'options: ["A","B"]\n---\n\n本文\n';
  const item = parseItem(md, 'x');
  assert.equal(item.broken, false);
  assert.equal(item.kind, 'decision');
  assert.equal(item.kindLabel, '判断');
  assert.equal(item.priority, 'high');
  assert.deepEqual(item.options, ['A', 'B']);
  assert.equal(item.body, '本文');
  assert.match(stringifyItem(item), /^---\nid: x\ntitle: どっち\nkind: decision\n/);
});

test('1件の中に往復が積まれる', () => {
  const md = '---\nkind: confirm\ntitle: 聞きたいこと\n---\n\n本文\n\n'
    + '<!-- reply claude 2026-09-20T10:00:00+09:00 -->\n\nこう考えています\n\n'
    + '<!-- reply you 2026-09-20T11:00:00+09:00 -->\n\nそれでいい\n';
  const item = parseItem(md, 'x');
  assert.equal(item.replies.length, 2);
  assert.deepEqual(item.replies.map((r) => r.who), ['claude', 'you']);
  assert.equal(item.replies[1].text, 'それでいい');

  // 書き戻しても失われない
  const round = parseItem(stringifyItem(item), 'x');
  assert.equal(round.replies.length, 2);
  assert.equal(round.replies[1].text, 'それでいい');
});

test('壊れていても例外を投げず、壊れたと申告する', () => {
  assert.equal(parseItem('frontmatter がない', 'x').broken, true);
  const noKind = parseItem('---\ntitle: あるけど kind が無い\n---\n', 'x');
  assert.equal(noKind.broken, true);
  assert.match(noKind.brokenWhy, /kind/);
});

test('未知の kind / status / priority は安全側に倒す', () => {
  const item = parseItem('---\nkind: なにこれ\ntitle: t\nstatus: へんな値\npriority: 超\n---\n', 'x');
  assert.equal(item.kind, null, '未知の kind を通している');
  assert.equal(item.status, 'open');
  assert.equal(item.priority, 'normal');
});

test('コロンや改行を含む値が往復しても壊れない', () => {
  const item = parseItem(stringifyItem({
    id: 'x', kind: 'fyi', title: '10:00 に確認: 請求', answer: '一行目\n二行目', replies: [],
  }), 'x');
  assert.equal(item.title, '10:00 に確認: 請求');
  assert.equal(item.answer, '一行目\n二行目');
});

/* ── 置き場所と名前 ───────────────────────── */

test('ファイル名は ASCII だけになる（NFC/NFD の衝突を避ける）', () => {
  assert.equal(newId('明日の朝いちでテストを走らせて', new Date(2026, 8, 20, 19, 44, 17)), '20260920-194417');
  assert.match(newId('Fix billing', new Date(2026, 8, 20, 1, 2, 3)), /^20260920-010203-fix-billing$/);
});

test('時刻はローカルのオフセット付きで、UTC の Z にならない', () => {
  assert.match(stamp(new Date()), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('板が無いワークスペースでも読めて、落ちない', async () => {
  assert.deepEqual(await readItems(await ws()), []);
});

test('同じ秒に日本語見出しで2件書いても、どちらも残る', async () => {
  const w = await ws();
  const a = await createItem(w, { kind: 'confirm', title: 'どっちにしますか' });
  const b = await createItem(w, { kind: 'confirm', title: 'こっちはどうですか' });
  assert.notEqual(a.id, b.id, 'id が衝突している');
  assert.equal(groupForBoard(await readItems(w)).waiting.length, 2);
});

test('片付けた直後に書いても、closed のものを上書きしない', async () => {
  const w = await ws();
  const a = await createItem(w, { kind: 'confirm', title: '先に聞いたこと' });
  await answerItem(w, a.id, '先の答え', { close: true });

  const b = await createItem(w, { kind: 'confirm', title: '次に聞いたこと' });
  assert.notEqual(a.id, b.id, 'closed にあるものと同じ id を取った');
  await answerItem(w, b.id, '次の答え', { close: true });

  const list = await readClosed(w);
  assert.equal(list.length, 2, '先の答えが上書きで消えた');
});

test('立て続けに20件書いても1件も落ちない', async () => {
  const w = await ws();
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    createItem(w, { kind: 'action', title: `依頼です${i}` })));
  assert.equal(groupForBoard(await readItems(w)).waiting.length, 20);
});

/* ── 状態遷移（誰待ちか） ─────────────────── */

test('回答すると「Claude 待ち」になる。完了にはならない', async () => {
  const w = await ws();
  const { id } = await createItem(w, { kind: 'decision', title: 'どっち', options: ['A', 'B'] });

  await answerItem(w, id, 'A');

  const g = groupForBoard(await readItems(w));
  assert.equal(g.waiting.length, 0, '受付に残っている');
  assert.equal(g.theirs.length, 1, 'Claude 待ちに移っていない');
  assert.equal(g.theirs[0].status, 'answered');
  assert.equal(g.theirs[0].answer, 'A');
  assert.equal(g.theirs[0].replies.length, 1, '会話に積まれていない');
  assert.equal(g.theirs[0].replies[0].who, 'you');

  // 片付いてはいない
  assert.equal((await readClosed(w)).length, 0);
});

test('「この回答で完了にする」を立てると、回答と同時に片付く', async () => {
  const w = await ws();
  const { id } = await createItem(w, { kind: 'confirm', title: 'これでいい？' });
  await answerItem(w, id, 'それでいい', { close: true });

  assert.equal(groupForBoard(await readItems(w)).theirs.length, 0);
  const closed = await readClosed(w);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].status, 'closed');
  assert.ok(closed[0].closed_at);
});

test('Claude 待ちのものを完了にできる', async () => {
  const w = await ws();
  const { id } = await createItem(w, { kind: 'action', title: 'やっておいて' });
  await answerItem(w, id, 'お願い');
  await closeItem(w, id);
  assert.equal((await readClosed(w))[0].status, 'closed');
});

test('取り下げは完了と区別される', async () => {
  const w = await ws();
  const { id } = await createItem(w, { kind: 'action', title: 'やっぱりいい' });
  await closeItem(w, id, { withdrawn: true });
  assert.equal((await readClosed(w))[0].status, 'withdrawn');
});

test('受付に戻すと、回答も会話の最後も消えて「あなた待ち」に戻る', async () => {
  const w = await ws();
  const { id } = await createItem(w, { kind: 'decision', title: '古い連携APIを落とす？', options: ['落とす', '残す'] });
  await answerItem(w, id, '落とす');
  await reopenItem(w, id);

  const g = groupForBoard(await readItems(w));
  assert.equal(g.waiting.length, 1);
  assert.equal(g.waiting[0].status, 'open');
  assert.equal(g.waiting[0].answer, '', '回答が残っている');
  assert.equal(g.waiting[0].replies.length, 0, '自分の回答が会話に残っている');
  assert.deepEqual(g.waiting[0].options, ['落とす', '残す'], '選択肢が失われている');
});

test('完了したものも受付に戻せる', async () => {
  const w = await ws();
  const { id } = await createItem(w, { kind: 'confirm', title: 'やっぱり考え直したい' });
  await answerItem(w, id, 'いいよ', { close: true });
  await reopenItem(w, id);

  assert.equal((await readClosed(w)).length, 0);
  assert.equal(groupForBoard(await readItems(w)).waiting.length, 1);
});

test('Claude の発言は受付に戻しても消えない', async () => {
  const w = await ws();
  const { id } = await createItem(w, { kind: 'confirm', title: '聞きたい' });
  // Claude が先に1つ書いた状態を作る
  const p = boardPaths(w);
  const file = path.join(p.items, `${id}.md`);
  const item = parseItem(await fs.readFile(file, 'utf8'), id);
  item.replies = [{ who: 'claude', at: stamp(), text: 'こう考えています' }];
  await fs.writeFile(file, stringifyItem(item), 'utf8');

  await answerItem(w, id, 'それでいい');
  await reopenItem(w, id);

  const back = groupForBoard(await readItems(w)).waiting[0];
  assert.equal(back.replies.length, 1, 'Claude の発言まで消している');
  assert.equal(back.replies[0].who, 'claude');
});

test('片付いた依頼には答えられない', async () => {
  const w = await ws();
  const { id } = await createItem(w, { kind: 'confirm', title: 'もう終わった' });
  await closeItem(w, id);
  await assert.rejects(() => answerItem(w, id, 'あとから'), /片付いた/);
});

test('無い依頼に触ると ENOENT で返る（500 にしない）', async () => {
  const w = await ws();
  await assert.rejects(() => answerItem(w, '20260101-000000-nope', 'x'), (e) => e.code === 'ENOENT');
});

/* ── 並び ─────────────────────────────────── */

test('受付は 優先度 → 起票順（desk の既定）', () => {
  const mk = (priority, created, title) => ({ priority, created, title });
  const list = [
    mk('normal', '2026-09-20T09:00:00+09:00', '普通・古い'),
    mk('high', '2026-09-20T18:00:00+09:00', '至急・新しい'),
    mk('low', '2026-09-20T08:00:00+09:00', '低・一番古い'),
    mk('high', '2026-09-20T10:00:00+09:00', '至急・古い'),
  ].sort(byPriorityThenAge);

  assert.deepEqual(list.map((e) => e.title), ['至急・古い', '至急・新しい', '普通・古い', '低・一番古い']);
});

test('壊れたものが1枚あっても、他は読める', async () => {
  const w = await ws();
  await createItem(w, { kind: 'decision', title: '本番昇格は人が承認する' });
  await fs.writeFile(path.join(boardPaths(w).items, 'garbage.md'), '---\nkind: なにこれ\n---\n', 'utf8');

  const g = groupForBoard(await readItems(w));
  assert.equal(g.waiting.length, 1);
  assert.equal(g.broken.length, 1);
});

/* ── タスク ───────────────────────────────── */

test('タスクを立てて、レーンを動かせる', async () => {
  const w = await ws();
  const { id } = await createTask(w, { title: '請求まわりのリファクタ' });

  let lanes = Object.fromEntries((await readTasks(w)).lanes.map((l) => [l.key, l.tasks]));
  assert.equal(lanes.inbox.length, 1);
  assert.equal(lanes.inbox[0].title, '請求まわりのリファクタ');

  await moveTask(w, id, 'inbox', 'doing');
  lanes = Object.fromEntries((await readTasks(w)).lanes.map((l) => [l.key, l.tasks]));
  assert.equal(lanes.inbox.length, 0);
  assert.equal(lanes.doing.length, 1);
});

test('タスクの「いまどこまで」を拾う', async () => {
  const w = await ws();
  await createTask(w, {
    title: '請求まわり',
    body: '**いまどこまで**: 明細をテストで固めた（38件パス）',
  });
  const doing = (await readTasks(w)).lanes.find((l) => l.key === 'inbox');
  assert.match(doing.tasks[0].now, /明細をテストで固めた/);
});

test('完了レーンは直近7日ぶんだけ出す', async () => {
  const w = await ws();
  const { id } = await createTask(w, { title: '古い完了' });
  await moveTask(w, id, 'inbox', 'done');

  // 8日前に触られたことにする
  const file = path.join(boardPaths(w).lanes.done, `${id}.md`);
  const old = new Date(Date.now() - 8 * 86400 * 1000);
  await fs.utimes(file, old, old);

  const done = (await readTasks(w)).lanes.find((l) => l.key === 'done');
  assert.equal(done.tasks.length, 0, '古い完了が出ている');
});

test('知らないレーンには動かせない', async () => {
  const w = await ws();
  const { id } = await createTask(w, { title: 't' });
  await assert.rejects(() => moveTask(w, id, 'inbox', '../../etc'), /レーン/);
});

/* ── 語彙が揃っていること ─────────────────── */

test('desk と同じ語彙を持っている', () => {
  assert.deepEqual(Object.keys(KINDS), ['decision', 'confirm', 'action', 'fyi']);
  assert.deepEqual(Object.values(KINDS), ['判断', '確認', '作業依頼', '共有']);
  assert.deepEqual(STATUSES, ['open', 'answered', 'closed', 'withdrawn']);
});

/* ── 板の置き場 ─────────────────────────────
 * ここを間違えると、Claude が板に書けない（`.claude/` は保護パスで
 * 書き込みが断られる）。実測で 0/5 → 3/3 に変わったところなので、
 * 既定が `.claude/` の中に戻っていないことを機械で見張る。
 */

test('既定の置き場は .claude/ の外', async () => {
  const dir = await ws();
  const p = boardPaths(dir);
  assert.equal(p.root, path.join(dir, '.board'));
  assert.equal(p.legacy, false);
  assert.ok(!p.root.includes(`${path.sep}.claude${path.sep}`), '.claude の中に戻っている');
});

test('すでに .claude/board/ で使っている板は、そのまま読み続ける', async () => {
  const dir = await ws();
  await fs.mkdir(path.join(dir, '.claude', 'board', 'items'), { recursive: true });
  const p = boardPaths(dir);
  assert.equal(p.root, path.join(dir, '.claude', 'board'));
  assert.equal(p.legacy, true);
});

test('両方あるときは新しい置き場を使う', async () => {
  const dir = await ws();
  await fs.mkdir(path.join(dir, '.claude', 'board', 'items'), { recursive: true });
  await fs.mkdir(path.join(dir, '.board', 'items'), { recursive: true });
  assert.equal(boardPaths(dir).root, path.join(dir, '.board'));
});

test('返信者の名前は、板に書かれているものをそのまま残す', async () => {
  // desk 由来の板は `from`/`who` が自由記述（PM・fix-routine など）。
  // こちらで `you` や `claude` に丸めると、誰が言ったのかが消える
  const dir = await ws();
  const { id } = await createItem(dir, { title: '送り主の保存', kind: 'confirm', from: 'PM' });
  await answerItem(dir, id, '確認しました', { who: '経理担当' });
  const [item] = (await readItems(dir)).filter((x) => x.id === id);
  assert.equal(item.from, 'PM');
  assert.equal(item.replies.at(-1).who, '経理担当');
});
