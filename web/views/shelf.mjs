/**
 * 受付の脇にある一覧。
 *
 * どれも「捌くもの」ではなく「見るもの・置くもの」なので、常時は畳んでおく。
 * 開いたときだけオーバーレイで出て、Esc で閉じる。受付の邪魔をさせない。
 */

import { el, chip, text, ago, waited, unknown, veil, entrySource, enterGuard, factSource } from '../ui.mjs';

/**
 * 帯に並ぶ名前は短く。長くすると帯が2段に割れて、受付の紙が押し下げられる。
 * 意味は開いたときの1行（NOTE）で担保する。
 */
export const TABS = [
  { id: 'tasks', label: 'タスク', key: 't' },
  { id: 'theirs', label: 'Claude の番', key: 'c' },
  { id: 'now', label: 'セッション', key: 'n' },
  { id: 'closed', label: '片付いた', key: 'a' },
  { id: 'new', label: '依頼を出す', key: 'i', noCount: true },
];

const KIND_CLASS = { decision: 'kind-decision', confirm: 'kind-confirm', action: 'kind-action', fyi: 'kind-fyi' };
const STATUS_JA = { waiting: 'あなたを待っている', busy: '作業中', idle: '手が空いている' };
const WAITING_JA = {
  'permission prompt': 'あなたの許可を待っている',
  'input needed': 'あなたの返事を待っている',
  'sandbox request': 'サンドボックスの許可を待っている',
  'worker request': 'ワーカーの許可を待っている',
  'dialog open': 'ダイアログが開いたまま',
};

function empty(msg) {
  return el('div', { class: 'item soft' }, [text('text', msg)]);
}

/** 依頼1件の札（種類・至急・PJ）。受付の紙と同じ読み方になるよう揃える。 */
function itemChips(e, extra = []) {
  return el('div', { class: 'meta' }, [
    chip(e.kindLabel ?? '依頼', KIND_CLASS[e.kind] ?? ''),
    e.priority === 'high' ? chip('至急', 'urgent') : null,
    e.project ? chip(e.project) : null,
    ...extra,
  ]);
}

/* ── タスク ───────────────────────────────── */

// README・使い方と同じ並びにする。左端が未着手
const LANE_ORDER = ['inbox', 'doing', 'done'];
const LANE_JA = { inbox: '未着手', doing: '着手中', done: '完了' };
// 進めるだけでなく、間違えたときに戻せる道も出す
const MOVES = {
  inbox: [['doing', '着手中へ']],
  doing: [['done', '完了へ'], ['inbox', '未着手へ戻す']],
  done: [['doing', '着手中へ戻す']],
};

function tasksTab(state, api) {
  const title = keeping(el('input', { type: 'text', placeholder: 'タスクを一行で', 'aria-label': 'タスク' }), 'draft:task:title', api);
  const send = el('button', { class: 'go', type: 'button', text: '未着手に置く' });

  const submit = async () => {
    const t = title.value.trim();
    if (!t) { title.focus(); api.toast('タスクを一行で書いてください'); return; }
    send.disabled = true;
    const payload = { title: t, lane: 'inbox' };
    title.value = '';
    api.keepDraft('draft:task:title', '');
    try {
      await api.post('/api/task', payload);
      api.toast('未着手に置きました');
      title.focus();
    } finally { send.disabled = false; }
  };
  send.addEventListener('click', submit);
  const titleComposing = enterGuard(title);
  title.addEventListener('keydown', (e) => {
    // 変換の確定 Enter で送らない
    if (e.key === 'Enter' && !titleComposing(e)) { e.preventDefault(); submit(); }
  });

  const lanes = state.tasks?.lanes ?? [];
  const byKey = Object.fromEntries(lanes.map((l) => [l.key, l]));

  const columns = LANE_ORDER.map((key) => {
    const lane = byKey[key];
    if (!lane) return null;
    return el('section', { class: `lane lane-${key}` }, [
      el('h3', {}, [
        el('span', { text: lane.label }),
        el('span', { class: 'n', text: String(lane.tasks.length) }),
      ]),
      lane.tasks.length
        ? el('div', { class: 'lane-body' }, lane.tasks.map((t) => el('div', { class: 'task' }, [
          el('div', { class: 'task-title', text: t.title }),
          el('div', { class: 'meta' }, [
            t.project ? chip(t.project) : null,
            el('span', { class: 'chip soft', text: ago(t.updated) ?? '' }),
          ]),
          t.now ? text('task-now', t.now) : null,
          el('div', { class: 'actions' }, MOVES[key].map(([to, label]) => el('button', {
            class: 'quiet', type: 'button', text: label,
            onclick: (ev) => {
              ev.currentTarget.disabled = true;
              api.post('/api/task-move', { id: t.id, from: key, to })
                .then(() => api.toast(`「${t.title}」を${LANE_JA[to]}に動かしました`, false, {
                  label: '戻す', run: () => api.post('/api/task-move', { id: t.id, from: to, to: key }),
                }))
                .catch(() => { ev.currentTarget.disabled = false; });
            },
          }))),
          entrySource({ id: t.id, lane: key }, api),
        ])))
        : el('div', { class: 'lane-empty', text: '—' }),
    ]);
  }).filter(Boolean);

  return [
    el('div', { class: 'field' }, [title, el('div', { class: 'row' }, [send])]),
    el('div', { class: 'lanes' }, columns),
  ];
}

/* ── Claude 待ち ───────────────────────────── */

function theirsTab(state, api) {
  const items = (state.theirs ?? []).map((e) => el('div', { class: 'item' }, [
    el('h3', { text: e.title ?? '' }),
    itemChips(e, [el('span', { class: 'chip soft', text: `${ago(e.answered_at || e.updated) ?? ''}に回答` })]),
    e.answer
      ? el('div', { class: 'said' }, [
        el('span', { class: 'said-label', text: 'あなたの回答' }),
        el('span', { class: 'said-text', text: e.answer }),
      ])
      : null,
    text('text', e.body),
    el('div', { class: 'actions' }, [
      el('button', {
        class: 'quiet', type: 'button', text: '完了にする',
        onclick: (ev) => { ev.currentTarget.disabled = true; api.close(e); },
      }),
      el('button', {
        class: 'quiet', type: 'button', text: '受付に戻す',
        title: '回答を取り消して、もう一度あなた待ちにします',
        onclick: (ev) => { ev.currentTarget.disabled = true; api.reopen(e.id); },
      }),
      el('button', {
        class: 'quiet', type: 'button', text: '取り下げる',
        title: 'やらなくてよくなったものを、完了とは分けて片付けます',
        onclick: (ev) => { ev.currentTarget.disabled = true; api.close(e, { withdrawn: true }); },
      }),
    ]),
    entrySource(e, api),
  ]));

  return items.length ? items : [empty('いま Claude が動いているものはありません')];
}

/* ── いまの作業（セッションから自動で拾う） ── */

function autoNow(s, api) {
  const waitingNow = s.status === 'waiting' || s.state === 'blocked';
  const label = s.waitingFor ? (WAITING_JA[s.waitingFor] ?? s.waitingFor) : (STATUS_JA[s.status] ?? s.status);

  return el('div', { class: 'item soft' }, [
    el('h3', {}, [s.name ? document.createTextNode(s.name) : unknown('セッション名が取れない')]),
    el('div', { class: 'meta' }, [
      el('span', {
        class: 'chip soft',
        title: '板のファイルではなく、動いているセッションから自動で拾った行です',
        text: '自動',
      }),
      s.status ? chip(label, waitingNow ? 'wait' : s.status === 'busy' ? 'go' : '') : unknown('状態が取れない'),
      s.cwd ? el('span', { class: 'chip soft', text: s.cwd.replace(/^.*\/(?=[^/]+\/?[^/]*$)/, '…/') }) : null,
    ]),
    s.lastPrompt
      ? veil('直近の指示', s.lastPrompt)
      : text('text', `直近の指示: 不明（${s.lastPromptWhy || '取れなかった'}）`),
    el('div', { class: 'actions' }, [
      el('button', {
        class: 'quiet', type: 'button', text: 'このセッションを開くコマンドをコピー',
        onclick: (ev) => api.copyResume(s, ev.currentTarget),
      }),
    ]),
    factSource([
      ['状態・作業場所', s.source?.state ?? 'claude agents --json'],
      ['セッションID', s.sessionId],
      s.pid ? ['プロセス', `pid ${s.pid}`] : null,
      s.source?.prompt
        ? ['直近の指示', `${s.source.prompt} の末尾 ${Math.round((s.source.tailBytes ?? 0) / 1024)}KB`]
        : (s.lastPrompt
          ? ['直近の指示', 'このセッションから直接（ログの場所は特定できず）']
          : ['直近の指示', 'ログが見つからないので取れていません']),
    ]),
  ]);
}

function nowTab(state, api) {
  const ses = state.sessions ?? {};
  if (!ses.available) {
    return [el('div', { class: 'item soft' }, [
      el('h3', {}, [unknown('動いているセッションが取れない')]),
      text('text', ses.why || ''),
      factSource([['叩いたコマンド', ses.command ?? 'claude agents --json']]),
    ])];
  }
  const list = ses.sessions ?? [];
  return list.length ? list.map((x) => autoNow(x, api)) : [empty('動いているセッションはありません')];
}

/* ── 片付いたもの ───────────────────────── */

const STATUS_LABEL = { closed: '完了', withdrawn: '取り下げ' };

function closedTab(state, api) {
  const items = (state.closed ?? []).map((e) => el('div', { class: 'item' }, [
    el('h3', { text: e.title ?? '' }),
    itemChips(e, [
      chip(STATUS_LABEL[e.status] ?? '片付いた', e.status === 'withdrawn' ? 'soft' : 'go'),
      el('span', { class: 'chip soft', text: ago(e.closed_at || e.updated) ?? '' }),
    ]),
    e.answer
      ? el('div', { class: 'said' }, [
        el('span', { class: 'said-label', text: 'あなたの回答' }),
        el('span', { class: 'said-text', text: e.answer }),
      ])
      : null,
    text('text', e.body),
    el('div', { class: 'actions' }, [
      el('button', {
        class: 'quiet', type: 'button', text: '受付に戻す',
        onclick: (ev) => { ev.currentTarget.disabled = true; api.reopen(e.id); },
      }),
    ]),
    entrySource(e, api),
  ]));

  return items.length ? items : [empty('まだ片付いたものはありません')];
}

/* ── 依頼を出す ───────────────────────────── */

/**
 * 書きかけを預ける入力欄。
 * 受付の答え欄は移動しても消えないのに、ここだけ消えると
 * 「どこが安全でどこが安全でないか分からない」になる。同じ扱いにする。
 */
function keeping(node, key, api) {
  node.value = api.draft(key);
  node.addEventListener('input', () => api.keepDraft(key, node.value));
  return node;
}

/**
 * 自分から出すときの言い方。
 *
 * 種類（判断・確認・作業依頼・共有）は Claude → 自分の向きで定義されている。
 * 同じ4語をそのまま出すと、自分 → Claude では意味が反転して読めなくなる
 * （「作業依頼＝人にしかできない操作」を Claude に頼むことになる）。
 * 保存する kind は同じまま、ラベルだけ向きに合わせる。
 */
const NEW_KINDS = [
  ['action', 'やってほしい', 'Claude に作業を頼む'],
  ['confirm', '見てほしい', 'こちらの案を確認してもらう'],
  ['decision', '決めておいた', '方針を伝える。判断は済んでいる'],
  ['fyi', '共有', '知っておいてほしいことを伝える'],
];

function newTab(state, api) {
  const demoNote = state.demo
    ? el('div', { class: 'src-note', text: 'demo なので、ここに書いても保存されません' })
    : null;

  let kind = 'action';
  const kindRow = el('div', { class: 'picker' }, NEW_KINDS.map(([k, label, why]) => {
    const b = el('button', {
      class: `pick${k === kind ? ' on' : ''}`, type: 'button', text: label, title: why,
      onclick: () => {
        kind = k;
        for (const other of kindRow.children) other.classList.toggle('on', other === b);
      },
    });
    return b;
  }));

  const title = keeping(el('input', { type: 'text', placeholder: '依頼を一行で', 'aria-label': '依頼' }), 'draft:new:title', api);
  const body = keeping(el('textarea', { rows: '3', placeholder: '補足（なくてもいい）', 'aria-label': '補足' }), 'draft:new:body', api);
  // 「板に置く」は、押す前に何が起きるか読めない。送ることを書く
  const send = el('button', { class: 'go', type: 'button', text: 'Claude に渡す' });

  const submit = async () => {
    const t = title.value.trim();
    if (!t) { title.focus(); api.toast('依頼を一行で書いてください'); return; }
    send.disabled = true;
    // 送る「前」に手元を空にする。再描画は post の途中でも起きるので、
    // あとで消すと書いた文字が戻ってきて、二重投稿の原因になる
    const payload = { title: t, body: body.value, kind };
    title.value = '';
    body.value = '';
    api.keepDraft('draft:new:title', '');
    api.keepDraft('draft:new:body', '');
    try {
      await api.post('/api/item', payload);
      api.toast('「Claude の番」に置きました。Claude が次に板を見たときに拾います');
      title.focus();
    } finally { send.disabled = false; }
  };
  send.addEventListener('click', submit);
  for (const f of [title, body]) {
    const composing = enterGuard(f);
    f.addEventListener('keydown', (e) => {
      // 変換の確定 Enter で送らない（見出しは Enter だけで送るので、ここが要る）
      if (composing(e)) return;
      if (e.key === 'Enter' && (f === title || e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
  }

  return [
    demoNote,
    el('div', { class: 'field' }, [
      kindRow, title, body,
      el('div', { class: 'row' }, [send, el('span', { class: 'hint', text: '⌘Enter で送信' })]),
    ]),
    el('div', { class: 'src-note', text: '置いたものは「Claude の番」に並びます。Claude が答えると受付に戻ってきます' }),
  ].filter(Boolean);
}

const BUILD = { tasks: tasksTab, theirs: theirsTab, now: nowTab, closed: closedTab, new: newTab };

const NOTE = {
  tasks: '未着手・着手中・完了。完了は直近7日ぶんだけ出しています',
  theirs: 'Claude の番のもの。あなたは手を離してよい — 答え終わったものと、こちらから渡したものが並びます',
  now: 'いま動いている Claude Code のセッション。板のファイルではなく、自動で拾っています',
  closed: '片付いたもの（完了・取り下げ）。押し間違えてもここから受付に戻せます（新しい順）',
  new: '',
};

/** 一覧1枚を組み立てる。 */
export function shelf(tabId, state, api) {
  const tabs = TABS.map((t) => el('button', {
    type: 'button', role: 'tab', 'aria-selected': String(t.id === tabId),
    text: `${t.label}${t.noCount ? '' : `（${api.shelfCount(t.id)}）`}`,
    onclick: () => api.openShelf(t.id),
  }));

  return el('section', {
    class: 'shelf', role: 'dialog', 'aria-modal': 'true', 'aria-label': '一覧', tabindex: '-1',
  }, [
    el('div', { class: 'shelf-head' }, [
      el('div', { class: 'tabs', role: 'tablist' }, tabs),
      el('div', { class: 'close' }, [
        el('button', { type: 'button', onclick: () => api.closeShelf() }, [
          el('span', { text: '閉じる' }), el('span', { class: 'esc-hint', text: '（Esc）' }),
        ]),
      ]),
    ]),
    el('div', { class: 'shelf-body' }, [
      NOTE[tabId] ? el('div', { class: 'src-note', text: NOTE[tabId] }) : null,
      el('div', { class: tabId === 'tasks' ? 'board-tasks' : 'items' }, BUILD[tabId](state, api)),
    ].filter(Boolean)),
  ]);
}

/** 使い方。`?` で開く。 */
export function help(api, state = {}) {
  const rows = [
    ['j / →', '次の依頼'],
    ['k / ←', '前の依頼'],
    ['1…9', 'その番号の選択肢で回答する'],
    ['r', 'コメント欄へ（reply）'],
    ['⌘Enter', '書いた内容を送る'],
    ['Esc', '入力欄から手を離す（もう一度で閉じる）'],
    ['t', 'タスクを開く'],
    ['c', '「Claude の番」を開く'],
    ['n', '動いているセッションを開く'],
    ['a', '片付いたものを開く'],
    ['i', 'Claude に依頼を出す'],
    ['u', '最後に回答したものを受付に戻す'],
    ['?', 'この画面'],
  ];

  return el('section', {
    class: 'shelf', role: 'dialog', 'aria-modal': 'true', 'aria-label': '使い方', tabindex: '-1',
  }, [
    el('div', { class: 'shelf-head' }, [
      el('h2', { text: '使い方' }),
      el('div', { class: 'close' }, [
        el('button', { type: 'button', onclick: () => api.closeShelf() }, [
          el('span', { text: '閉じる' }), el('span', { class: 'esc-hint', text: '（Esc）' }),
        ]),
      ]),
    ]),
    el('div', { class: 'shelf-body' }, [
      el('div', { class: 'howto' }, [
        text('p', 'Claude からの依頼が1件ずつ「受付」に出ます。回答すると「Claude の番」に移り、受付から外れます。'),
        text('p', '依頼は4つの種類に分かれます — 判断（決めてほしい）／確認（これでいいか見てほしい）／作業依頼（人にしかできない操作をしてほしい）／共有（報告。返事は要らない）。'),
        text('p', '**回答しても完了にはなりません。** Claude が動いた結果を見てから「完了にする」を押す形です。そのぶん「答えたのに直っていなかった」を取りこぼしません。その場で終わらせたいときは、回答欄の「この回答で完了にする」にチェックを入れてから送ってください。'),
        text('p', '選択肢は押した瞬間に回答になります。書きかけのコメントも一緒に送られます。押し間違えても「Claude の番」からいつでも受付に戻せます。'),
        text('p', 'タスクは未着手・着手中・完了の3列。Claude も人も同じファイル（.claude/board/tasks/）を動かします。'),
        text('p', 'この画面が「板」と呼んでいるのは、ワークスペースの .claude/board/ にある md ファイルの集まりです。画面はその窓で、どの行もファイル名から中身を開けます。'),
        text('p', `いま見ている板: ${state.boardDir ?? state.workspace ?? '(demo — ファイルは読んでいません)'}`),
        el('p', {
          class: 'howto-note',
          text: '板が空のままなら、Claude 側の設定がまだかもしれません。同梱の templates/CLAUDE.board.md を自分の CLAUDE.md に貼るか @ で読み込ませてください。板は、Claude が書いてくれて初めて板になります。',
        }),
      ]),
      el('div', { class: 'keys' }, rows.map(([k, what]) => el('div', { class: 'k' }, [
        el('kbd', { text: k }), el('span', { text: what }),
      ]))),
    ]),
  ]);
}
