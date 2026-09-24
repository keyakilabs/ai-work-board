/**
 * 板の組み立て。
 *
 * 画面は2つしかない。「今さばく1件」と、要るときだけ開く「棚」。
 * ここはその2つを切り替えて、キーボードを受けるだけ。
 */

import { el, ellipsizeMiddle } from './ui.mjs';
import { art } from './art.mjs';
import { sheet, clearStage } from './views/inbox.mjs';
import { shelf, help, TABS } from './views/shelf.mjs';
import { bot, bindBot, botFlash, clearFlash, markSeen, playDelivery, watchIdle } from './views/bot.mjs';

const $ = (id) => document.getElementById(id);

/**
 * `replaceChildren(null)` は文字列 "null" を置いてしまう。
 * `el()` の children と同じ感覚で書けるよう、空のものを落としてから渡す。
 */
function put(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

/**
 * 中身が前と同じなら、DOM を作り直さない。
 *
 * 1回の回答で板の通知は複数回届く（書いた直後・監視が見つけたとき・
 * ファイルが移動したとき）。そのたびに全部作り直すと、紙が入れ替わる
 * アニメーションが連続で走って画面がチカチカする。
 * 作り直さなければ、書きかけの文章やスクロール位置もそのまま残る。
 */
function paint(host, sig, build) {
  if (host.dataset.sig === sig && host.firstChild) return false;
  host.dataset.sig = sig;
  put(host, build());
  return true;
}

/* ── 状態 ─────────────────────────────────
 * 見ている相談は「何番目か」ではなく「どの id か」で覚える。番号で覚えると、
 * Claude が裏で1件書き足した瞬間に、読んでいた紙が別のものに差し替わる。
 */
let state = null;
let token = null;
let cursorId = null;
let shelfTab = null;      // null / タブID / 'help'
let current = null;       // いま描いている紙（キーボードから触るため）
let lastSheetId = null;   // 直前に出した紙。別の紙になったときだけ入れ替えを見せる
let lastAnswer = null;    // 直前に答えたときの操作（続けて叩かれたかの判定用）
let justAnswered = false; // 答えた直後の1回だけは、入力中でも紙を描き直す
let connected = true;     // サーバとつながっているか（係の姿勢に出す）

/**
 * 一度でも受付に並んだ id。
 *
 * ここに無いものが受付に現れたら「新しく届いた」ということなので、係が
 * 持ってくる。受付に戻したものは既に入っているので、戻すたびに配達は起きない。
 */
const known = new Set();

/**
 * 書きかけの答え。
 *
 * カードを送るたびに DOM ごと作り直すので、何もしないと入力中の文章が消える。
 * 「押し間違えても戻せる」と言っているツールで、唯一戻せないのが自分の書いた
 * 文章、というのが一番まずい。
 */
const DRAFT_KEY = 'ai-work-board:drafts';

/* ── 明るさ ─────────────────────────────────
 * 既定は OS に合わせる（style.css のメディアクエリが拾う）。
 * 選んだときだけ html に印を付けて、そちらを優先させる。
 */
const THEME_KEY = 'ai-work-board:theme';
const THEMES = [
  { id: 'auto', label: 'OSに合わせる', icon: 'theme-auto' },
  { id: 'light', label: '明るい', icon: 'theme-light' },
  { id: 'dark', label: '暗い', icon: 'theme-dark' },
];

function loadTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.some((t) => t.id === v) ? v : 'auto';
  } catch { return 'auto'; }
}

let theme = loadTheme();

function applyTheme() {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;
}

function cycleTheme() {
  const at = THEMES.findIndex((t) => t.id === theme);
  theme = THEMES[(at + 1) % THEMES.length].id;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 無くても切り替わる */ }
  applyTheme();
  render();
  toast(`画面を「${THEMES.find((t) => t.id === theme).label}」にしました`);
}

// 画面が描かれる前に当てる。押したあと reload しても選んだままにするため
applyTheme();

/**
 * 書きかけはリロードしても残す。
 *
 * 1日中開きっぱなしにして使うものなので、⌘R はふつうに起きる。ほかの全部で
 * 「戻せます」を守っているのに、ここだけ落ちるのは落差が大きい。
 * localStorage が使えない環境（プライベートウィンドウ等）でも板は動く。
 */
function loadDrafts() {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}')));
  } catch { return new Map(); }
}

function saveDrafts() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(drafts))); } catch { /* 無くても動く */ }
}

const drafts = loadDrafts();

/**
 * 答えたときに預かった書きかけ。
 *
 * 選択肢を押すと、自由記述に書いていた文章は答えにならない。ここで捨てると
 * 「取り消せます」と言いながら、一番戻したいもの（自分が書いた文章）だけが
 * 戻らないことになる。取り消したときに一緒に返す。
 */
const keptDrafts = new Map();

/** 受付に並ぶもの＝あなた待ち（open）。 */
function waiting() { return state?.waiting ?? []; }

function cursorIndex() {
  const list = waiting();
  const i = list.findIndex((e) => e.id === cursorId);
  return i >= 0 ? i : 0;
}

/* ── サーバとのやりとり ───────────────────── */

/**
 * demo は画面の中だけで動かす。
 *
 * サーバは demo での書き込みを断るので、素直に投げるとエラーが出る。
 * 初めて触る人が最初に押すのは選択肢なので、そこで赤いエラーを出すと
 * 「壊れている」と読まれる。demo では手元の state を書き換えて、
 * 保存されないことだけを伝える。
 */
const demoClosed = new Map();

function demoWrite(path, payload) {
  const now = new Date().toISOString();

  if (path === '/api/answer') {
    const gone = state.waiting.find((e) => e.id === payload.id);
    if (gone) {
      demoClosed.set(payload.id, gone);
      const answered = { ...gone, answer: payload.answer, answered_at: now, updated: now };
      if (payload.close) {
        state.closed = [{ ...answered, where: 'closed', status: 'closed', closed_at: now }, ...(state.closed ?? [])];
      } else {
        state.theirs = [{ ...answered, status: 'answered' }, ...(state.theirs ?? [])];
      }
    }
    state.waiting = state.waiting.filter((e) => e.id !== payload.id);

  } else if (path === '/api/close') {
    const gone = (state.theirs ?? []).find((e) => e.id === payload.id);
    if (gone) {
      state.theirs = state.theirs.filter((e) => e.id !== payload.id);
      state.closed = [{ ...gone, where: 'closed', status: 'closed', closed_at: now }, ...(state.closed ?? [])];
    }

  } else if (path === '/api/reopen') {
    for (const k of ['theirs', 'closed']) {
      const back = (state[k] ?? []).find((e) => e.id === payload.id);
      if (!back) continue;
      state[k] = state[k].filter((e) => e.id !== payload.id);
      state.waiting = [...state.waiting, {
        ...back, where: 'items', status: 'open', answer: '', answered_at: '', closed_at: '',
      }].sort((a, b) => String(a.created).localeCompare(String(b.created)));
    }

  } else if (path === '/api/item') {
    state.theirs = [{
      id: `demo-new-${Date.now()}`, where: 'items', kind: payload.kind || 'action',
      kindLabel: { decision: '判断', confirm: '確認', action: '作業依頼', fyi: '共有' }[payload.kind || 'action'],
      title: payload.title, body: payload.body ?? '', priority: 'normal', status: 'answered',
      project: '', from: 'you', origin: 'board-ui', created: now, updated: now,
      options: [], links: [], replies: [], answer: '', answered_at: '', closed_at: '', broken: false,
    }, ...(state.theirs ?? [])];

  } else if (path === '/api/task') {
    const lane = (state.tasks?.lanes ?? []).find((l) => l.key === (payload.lane || 'inbox'));
    if (lane) {
      lane.tasks = [{
        id: `demo-task-${Date.now()}`, lane: lane.key, title: payload.title,
        now: '', project: '', updated: now,
      }, ...lane.tasks];
    }

  } else if (path === '/api/task-move') {
    const lanes = state.tasks?.lanes ?? [];
    const from = lanes.find((l) => l.key === payload.from);
    const to = lanes.find((l) => l.key === payload.to);
    const t = from?.tasks.find((x) => x.id === payload.id);
    if (from && to && t) {
      from.tasks = from.tasks.filter((x) => x.id !== payload.id);
      to.tasks = [{ ...t, lane: to.key, updated: now }, ...to.tasks];
    }
  }

  return { ok: true, demo: true };
}

async function post(path, payload) {
  if (state?.demo) { const r = demoWrite(path, payload); render(); return r; }
  if (!token) throw new Error('まだつながっていません');
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board-token': token },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    toast(error || `うまくいきませんでした（${res.status}）`, true);
    throw new Error(error || String(res.status));
  }
  return res.json();
}

const api = {
  post,

  /** 画面に出ている1件の、ディスク上の中身。 */
  async raw(q) {
    if (state?.demo) {
      return {
        path: '（demo なのでファイルはありません）',
        text: 'demo モードでは、あなたのディスクを一切読んでいません。\n'
          + '本物の板では、ここにそのファイルの中身がそのまま出ます。',
      };
    }
    const qs = new URLSearchParams(q).toString();
    const res = await fetch(`/api/raw?${qs}`);
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error || `読めませんでした（${res.status}）`);
    }
    return res.json();
  },

  /**
   * 相談に答える。
   * 答えたらその場に留まらず、次の1件へ送る — 1件ずつ片付ける画面なので、
   * 「答えたのにまだ目の前にある」状態を作らない。
   */
  lastAnswer: () => lastAnswer,

  /**
   * 回答する。
   *
   * 既定では「Claude 待ち」になるだけで、完了にはしない。回答を受けて
   * Claude が動き、それを見てから完了にするのが desk のやり方。
   * `close` を立てると、回答と同時に完了まで進む。
   */
  async answer(id, value, { close = false, gesture = null } = {}) {
    lastAnswer = gesture ? { ...gesture, at: Date.now() } : null;
    justAnswered = true;

    const list = waiting();
    const at = list.findIndex((e) => e.id === id);
    const next = list[at + 1] ?? list[at - 1] ?? null;
    // 送る前に行き先を決めておく。post の途中で画面が描き直されると、
    // 居場所を見失って先頭に引き戻される
    cursorId = next ? next.id : null;

    // 書きかけは消さずに預かる。受付に戻すときに一緒に返すため。
    // 消すのは送れたあと — 失敗したときに書いた文章まで失うのが一番まずい
    const kept = drafts.get(id) ?? '';
    await post('/api/answer', { id, answer: value, close });
    drafts.delete(id);
    saveDrafts();
    if (kept) keptDrafts.set(id, kept);

    if (isTyping()) document.activeElement.blur();
    justAnswered = true;
    render();
    $('stage').focus();

    if (waiting().length === 0) clearToast();
    const label = ellipsizeMiddle(value, 28);
    const where = close ? '完了にしました' : '「Claude の番」に移しました';
    // 送れたことは、画面の下（トースト）と左（係）の両方で言う。
    // 目が行っている方で必ず拾えるように
    botFlash(close
      ? { pose: 'cheer', line: '完了で承りました', sub: '「片付いた」に入れておきます', tone: 'done' }
      : { pose: 'out', line: 'おあずかりしました', sub: 'Claude へ回してきます' });
    toast(
      state?.demo
        ? `「${label}」で回答し、${where}（demo なので保存はされません）`
        : `「${label}」で回答し、${where}`,
      false,
      { label: '受付に戻す', run: () => api.reopen(id) },
    );
  },

  /** 受付に戻す。回答の取り消しも、完了の取り消しも同じ口。 */
  async reopen(id) {
    const found = [...(state?.theirs ?? []), ...(state?.closed ?? [])].find((e) => e.id === id);
    try {
      cursorId = id;
      const kept = keptDrafts.get(id);
      if (kept) { drafts.set(id, kept); keptDrafts.delete(id); saveDrafts(); }
      await post('/api/reopen', { id });
      shelfTab = null;      // 戻ったものを見せたいので一覧は閉じる
      render();
      toast(found?.title ? `「${found.title}」を受付に戻しました` : '受付に戻しました');
    } catch { /* post 側でトーストが出る */ }
  },

  /** 完了にする／取り下げる。 */
  async close(item, { withdrawn = false } = {}) {
    try {
      await post('/api/close', { id: item.id, withdrawn });
      toast(`「${item.title}」を${withdrawn ? '取り下げました' : '完了にしました'}`, false, {
        label: '受付に戻す', run: () => api.reopen(item.id),
      });
    } catch { /* post 側でトーストが出る */ }
  },

  shelfCount: (id) => shelfCount(state, id),
  draft: (id) => drafts.get(id) ?? '',
  keepDraft: (id, v) => { if (v) drafts.set(id, v); else drafts.delete(id); saveDrafts(); },

  /** その紙を開く。係が言っていることの現物へ連れていく口。 */
  goTo(id) {
    if (!waiting().some((e) => e.id === id)) return;
    cursorId = id;
    shelfTab = null;
    render();
    $('stage').focus();
  },
  openShelf(tab) { shelfTab = tab; render(); },
  closeShelf() { shelfTab = null; render(); $('stage').focus(); },
  toast,
};

let toastTimer = null;

/**
 * 知らせは常に1枚だけ。
 *
 * 積み上げると、続けて片付けるほど画面下が塞がっていく。このツールの本来の
 * 使い方が「たまった相談を一気に片付ける」なので、正しく使うほど邪魔になる。
 * 古いものは新しいもので置き換える。取り消し済みの案内が残って「まだ戻せる」
 * ように見える事故も、これで一緒に消える。
 */
function toast(message, bad = false, action = null) {
  const box = $('toasts');
  const n = el('div', { class: `toast${bad ? ' bad' : ''}` }, [
    el('span', { text: message }),
    action ? el('button', {
      class: 'undo', type: 'button', text: action.label,
      onclick: () => { clearToast(); action.run(); },
    }) : null,
    // 閉じられないバーは、狭い画面では操作の邪魔にしかならない
    action ? el('button', {
      class: 'shut', type: 'button', 'aria-label': '閉じる', title: '閉じる', text: '×',
      onclick: clearToast,
    }) : null,
  ]);
  box.replaceChildren(n);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.replaceChildren(), action ? 12000 : 3600);
}

function clearToast() {
  clearTimeout(toastTimer);
  $('toasts').replaceChildren();
}

/* ── 描画 ─────────────────────────────────── */

/** タブの数字は「あなたが答えるべき枚数」。 */
function renderTitle() {
  const list = waiting();
  // どの板かをタブに出す。プロジェクトごとに立てるものなので、
  // 2つ開いたときに見分けられないと、別の板に答えてしまう
  const where = state?.demo ? 'demo' : folderName(state?.boardDir ?? state?.workspace);
  const name = where ? `${where} · ai-work-board` : 'ai-work-board';
  document.title = list.length ? `(${list.length}) ${name}` : name;
}

/**
 * 係。
 *
 * 「いま何件あなた待ちか」は、数字の帯ではなくこの人が言う。帯にすると読む
 * 対象がひとつ増えるだけだが、姿勢なら読む前に伝わる。
 */
function renderBot() {
  const host = $('botslot');
  const node = bot(state, api, { connected, cursorId });
  // bot() が自分で付けた印で見分ける。中身が同じなら入れ替えない
  if (host.dataset.sig === node.dataset.sig && host.firstChild) return;
  host.dataset.sig = node.dataset.sig;
  host.replaceChildren(node);
}

/** 一覧の数字は「開いたときに並ぶ枚数」にする。数字と中身が食い違うと信用を失う。 */
export function shelfCount(st, id) {
  if (id === 'tasks') return (st?.tasks?.lanes ?? []).reduce((n, l) => n + l.tasks.length, 0);
  if (id === 'new') return 0;
  return (st?.[id] ?? []).length;
}

/**
 * 棚。
 *
 * 画面の右に立てて、ふだんは絵と数字だけ出す。名前はマウスを乗せたときと
 * タブで入ったときだけ。一覧は「要るときに開くもの」で、ずっと見えている
 * 必要がない — 常時7つの名前が並んでいると、そこも読む対象になる。
 */
const RACK = [
  {
    label: 'スレッド',
    items: [
      {
        id: 'inbox', icon: 'tray-in', label: '受付',
        count: () => waiting().length,
        hot: () => waiting().some((e) => e.priority === 'high'),
        hotLabel: '至急',
        act: () => { shelfTab = null; render(); $('stage').focus(); },
        title: 'いま答える紙。押すと受付に戻ります',
      },
      { id: 'theirs', icon: 'tray-out' },
      { id: 'closed', icon: 'box-done' },
    ],
  },
  // タスクは「スレッド」とは別のもの。同じまとまりに入れると、
  // レールが何の一覧なのか読めなくなる
  {
    label: 'タスク',
    items: [{ id: 'tasks', icon: 'board' }],
  },
  {
    label: '道具',
    items: [
      { id: 'new', icon: 'pen' },
      { id: 'help', icon: 'keys', label: '使い方', key: '?', title: 'キーと使い方' },
      {
        id: 'theme',
        icon: () => THEMES.find((t) => t.id === theme).icon,
        label: () => `画面: ${THEMES.find((t) => t.id === theme).label}`,
        title: '押すたびに OSに合わせる → 明るい → 暗い と変わります',
        act: cycleTheme,
      },
    ],
  },
];

function rackItem(spec) {
  const tab = TABS.find((t) => t.id === spec.id);
  const label = (typeof spec.label === 'function' ? spec.label() : spec.label) ?? tab?.label ?? spec.id;
  const icon = typeof spec.icon === 'function' ? spec.icon() : spec.icon;
  const key = spec.key ?? tab?.key ?? '';
  // `noCount` は「自動で数えない」ではなく「出さない」。札が独自に数えていても
  // こちらが勝つ。でないと、札に `count` を足すだけで数字が戻ってしまう
  const n = tab?.noCount ? null
    : (spec.count ? spec.count() : (tab ? shelfCount(state, spec.id) : null));
  const hot = spec.hot ? spec.hot() : false;

  return el('button', {
    class: `rack-item${hot ? ' hot' : ''}`,
    type: 'button',
    title: `${spec.title ?? label}${key ? `（${key}）` : ''}`,
    // 畳んでいるときは名前が見えないので、読み上げには名前を必ず渡す（件数は出す札だけ）
    'aria-label': n === null ? label : `${label} ${n}件`,
    onclick: spec.act ?? (() => api.openShelf(spec.id)),
  }, [
    art(icon, { cls: 'ri' }),
    el('span', { class: 'rl', text: label }),
    n === null ? null : el('b', { class: 'rn', text: String(n) }),
    key ? el('span', { class: 'rk kbd-only', text: key }) : null,
    hot ? el('span', { class: 'rtag', text: spec.hotLabel ?? '待ち' }) : null,
  ]);
}

/** パスから、見分けのつく最後のフォルダ名だけを取り出す。 */
function folderName(p) {
  if (!p) return '';
  return p.replace(/\/\.board\/?$/, '').replace(/\/\.claude\/board\/?$/, '')
    .split('/').filter(Boolean).pop() ?? '';
}

function rackSig() {
  return JSON.stringify([
    RACK.map((g) => g.items.map((it) => {
      const tab = TABS.find((t) => t.id === it.id);
      return [
        tab?.noCount ? null : (it.count ? it.count() : (tab ? shelfCount(state, it.id) : null)),
        it.hot ? it.hot() : false,
      ];
    })),
    state?.boardDir ?? state?.workspace ?? null,
    theme,
  ]);
}

function renderRack() {
  const rack = $('rack');
  const sig = rackSig();
  if (rack.dataset.sig === sig && rack.firstChild) return;
  rack.dataset.sig = sig;
  const groups = RACK.map((g) => el('section', {
    class: 'rack-group', 'aria-label': g.label,
  }, [
    // 畳んでいる間は絵だけ。開いたときに「ここからここまでが何か」を出す。
    // 1件だけのまとまりは札の名前がそのまま見出しになるので、重ねない
    g.items.length > 1 ? el('span', { class: 'rg-label', text: g.label }) : null,
    ...g.items.map(rackItem),
  ]));

  // 足元に、板そのものの居場所を置く。画面に出ているものがディスクの
  // どこなのかは、紙ごとの「出どころ」で分かるが、板全体の場所はここ
  // 長いパスは畳んだ棚に入らないうえ、末尾が切れて見分けがつかない。
  // 板を2枚開いて使うので、見分けがつく所（フォルダ名）を出す
  const where = state?.boardDir ?? state?.workspace ?? null;
  const folder = where ? (folderName(where) || where) : 'demo';
  groups.push(el('p', { class: 'rack-foot', title: where ?? 'demo — ファイルは読んでいません' }, [
    el('span', { class: 'rf-name', text: folder }),
    el('span', { class: 'rf-where', text: where ?? 'demo — ファイルは読んでいません' }),
  ]));

  rack.replaceChildren(el('div', { class: 'rack-inner' }, groups));
}

function alertSig() {
  return JSON.stringify([
    !!state?.demo,
    !!state?.legacyDir,
    (state?.broken ?? []).map((b) => `${b.id}|${b.brokenWhy ?? ''}`),
  ]);
}

function renderAlerts() {
  const box = $('alerts');
  if (box.dataset.sig === alertSig() && box.firstChild) return;
  box.dataset.sig = alertSig();
  const rows = [];

  if (state?.demo) {
    rows.push(el('div', {
      class: 'alert',
      text: 'demo — あなたのファイルは読んでいません。この画面での操作は見た目だけで、閉じると元に戻ります',
    }));
  }
  // 古い置き場のままだと Claude は板に書けない（.claude/ は保護パス）。
  // 板が空のままになる一番の原因なので、直し方まで出す
  if (state?.legacyDir) {
    rows.push(el('div', { class: 'alert warn' }, [
      el('span', { text: '板が .claude/ の中にあります。Claude Code は .claude/ への書き込みを断るので、このままだと Claude が板に書けません。' }),
      el('button', {
        class: 'tiny', type: 'button', text: '直し方',
        onclick: (e) => {
          const ws = String(state.workspace ?? '');
          e.currentTarget.replaceWith(el('code', {
            text: `mv ${ws}/.claude/board ${ws}/.board`,
          }));
        },
      }),
    ]));
  }
  for (const b of state?.broken ?? []) {
    rows.push(el('div', { class: 'alert bad' }, [
      el('span', { text: `読めないファイル: ${b.id}.md — ${b.brokenWhy || '形式が違う'}` }),
      el('button', {
        class: 'tiny', type: 'button', text: '中身を見る',
        onclick: async (e) => {
          try {
            const { path: p, text: raw } = await api.raw({ where: b.where ?? 'items', id: b.id });
            e.currentTarget.replaceWith(el('code', { text: p }), el('pre', { class: 'raw', text: raw }));
          } catch (err) { toast(err.message, true); }
        },
      }),
    ]));
  }
  box.replaceChildren(...rows);
}

/** いま何かを打っている最中か。打っている人の手元は壊さない。 */
function isTyping() {
  const a = document.activeElement;
  return a instanceof HTMLElement
    && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}

function renderStage() {
  const slot = $('paper');
  const list = waiting();

  // 書いている途中で紙を作り直すと、入力中の欄ごと消えてフォーカスが飛ぶ。
  // 「答えを書きかけて棚を見に行って戻る」がこのツールの
  // ど真ん中の使い方なので、そこで入力が落ちるのは致命的。
  //
  // ただし「答えた直後」は別。⌘Enter で答えると欄にフォーカスが残ったまま
  // なので、ここで止めると答えたのに同じ紙が残り、次へも進まなくなる。
  if (current && isTyping() && !justAnswered && list.some((e) => e.id === cursorId)) return;
  justAnswered = false;

  // ここで current を捨てない。捨てると「同じ紙がそのまま出ている」かを
  // 見分けられなくなり、下の作り直し回避が必ず素通りする

  if (list.length === 0) {
    current = null;
    lastSheetId = null;
    paint(slot, `empty|${JSON.stringify([(state.theirs ?? []).length, (state.closed ?? []).length, state.tasks, state.demo])}`,
      () => clearStage(state, api));
    return;
  }
  const entry = list[cursorIndex()];
  cursorId = entry.id;
  // 出した紙は「目を通した」扱いにする。読んだものを係が
  // 「新しくおもちしました」と言い続けると、どれが新着か分からなくなる
  markSeen(entry.id);
  // 同じ紙が同じ中身のまま届いたら、そのまま置いておく。作り直すと
  // 入れ替えのアニメーションが走って瞬き、書きかけの文章の見え方も乱れる
  const sig = JSON.stringify(entry);
  if (current && slot.dataset.sig === sig && slot.firstChild === current.node) return;

  // 入れ替えたことを見せるのは、本当に別の紙になったときだけ
  const swapped = lastSheetId !== entry.id;
  lastSheetId = entry.id;
  slot.dataset.sig = sig;
  current = sheet(entry, api, { swapped });
  slot.replaceChildren(current.node);
}

/** 紙送り。前 / 何枚目 / 次。一覧は画面に出さない。 */
function renderPager() {
  const pager = $('pager');
  const list = waiting();
  if (list.length <= 1) { pager.replaceChildren(); pager.dataset.sig = ''; pager.hidden = true; return; }

  const i = cursorIndex();
  const sig = `${i}/${list.length}`;
  if (pager.dataset.sig === sig && pager.firstChild) { pager.hidden = false; return; }
  pager.dataset.sig = sig;
  pager.hidden = false;
  pager.replaceChildren(
    el('button', { class: 'pg', type: 'button', 'aria-label': '前の紙（k）', title: '前の紙（k）', text: '‹', disabled: i === 0, onclick: () => step(-1) }),
    el('span', { class: 'pg-pos', text: `${i + 1} / ${list.length}` }),
    el('button', { class: 'pg', type: 'button', 'aria-label': '次の紙（j）', title: '次の紙（j）', text: '›', disabled: i >= list.length - 1, onclick: () => step(1) }),
  );
}

function renderShelf() {
  const ov = $('overlay');
  // 棚を開けている間、後ろの部屋には Tab で入れないようにする。
  // 入れてしまうと、見えていない棚のボタンに枠だけが移って迷子になる
  const room = document.querySelector('.room');
  if (!shelfTab) {
    ov.hidden = true; ov.replaceChildren();
    room?.removeAttribute('inert');
    return;
  }
  room?.setAttribute('inert', '');
  ov.hidden = false;
  ov.replaceChildren(shelfTab === 'help' ? help(api, state) : shelf(shelfTab, state, api));
  // 入力欄があるタブはそこへ、無ければ棚そのものへ。
  // 先頭のボタンに当てると、選んでいないタブに枠が乗って紛らわしい
  // 入力欄に自動でフォーカスすると、n/m/d/a でパネルを行き来できなくなる。
  // スマホでは見るだけのつもりでキーボードが立ち上がってしまう
  ov.querySelector('.shelf')?.focus();
}

function render() {
  if (!state) return;
  renderTitle();
  renderStage();
  // 係より先に紙を描く。係は「まだ読んでいないもの」を数えるので、
  // 逆にすると、これから目の前に出す1件まで新着に数えてしまう
  renderBot();
  renderRack();
  renderAlerts();
  renderPager();
  renderShelf();
}

function step(by) {
  const list = waiting();
  if (list.length === 0) return;
  const next = Math.min(list.length - 1, Math.max(0, cursorIndex() + by));
  cursorId = list[next].id;
  render();
}

/* ── キーボード ───────────────────────────── */

function typing(e) {
  const t = e.target;
  return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // 入力中なら、まず手を離すだけ。もう一度で閉じる（使い方の記述どおり）
    if (typing(e)) { e.target.blur(); return; }
    if (shelfTab) { api.closeShelf(); return; }
    return;
  }
  // 入力中はショートカットを奪わない。書いている途中に画面が変わるのが一番困る
  if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;

  if (shelfTab) {
    if (e.key === '?') { shelfTab = shelfTab === 'help' ? null : 'help'; render(); return; }
    // 棚の中でも同じキーでタブを行き来できる。ここだけ効かないと
    // 「効かないキーがある」と読まれて、ほかのキーまで信用されなくなる
    const tab = TABS.find((x) => x.key === e.key);
    if (tab) { e.preventDefault(); shelfTab = tab.id; render(); }
    return;
  }

  switch (e.key) {
    case 'j': case 'ArrowRight': e.preventDefault(); step(1); break;
    case 'k': case 'ArrowLeft': e.preventDefault(); step(-1); break;
    case 'r': e.preventDefault(); current?.focusReply(); break;
    case 't': case 'c': case 'a': case 'i': {
      const tab = TABS.find((x) => x.key === e.key);
      if (tab) { e.preventDefault(); api.openShelf(tab.id); }
      break;
    }
    case 'u': {
      e.preventDefault();
      const last = (state?.theirs ?? [])[0] ?? (state?.closed ?? [])[0];
      if (last) api.reopen(last.id);
      else toast('戻せるものはありません');
      break;
    }
    case '?': e.preventDefault(); api.openShelf('help'); break;
    default:
      if (/^[1-9]$/.test(e.key) && current?.choose(Number(e.key) - 1)) e.preventDefault();
  }
});

$('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) api.closeShelf(); });

/* ── 起動 ─────────────────────────────────── */

/**
 * 新しい状態を受け取る。
 *
 * ここで「今回はじめて受付に現れたもの」を拾って、係に持ってこさせる。
 * 受付に戻したものは `known` に入っているので、戻すたびに配達は起きない。
 */
function setState(next, { first = false } = {}) {
  state = next;
  // 見ていた相談が無くなっていたら、先頭に戻す
  if (cursorId && !waiting().some((e) => e.id === cursorId)) cursorId = waiting()[0]?.id ?? null;
  if (!cursorId) cursorId = waiting()[0]?.id ?? null;

  const fresh = waiting().filter((e) => !known.has(e.id));
  for (const e of waiting()) known.add(e.id);

  render();

  // 描いたあとで動かす。紙の位置が決まっていないと、差し出す先が分からない。
  // 裏のタブで届いたぶんは係が預かるので、そのとき「まだ受付に残っているか」を
  // 聞けるようにしておく（見ていない間に片付いたものは運ばせない）
  if (fresh.length) {
    requestAnimationFrame(() => playDelivery(fresh, {
      reveal: first,
      alive: (list) => list.filter((e) => waiting().some((w) => w.id === e.id)),
    }));
  }
}

async function boot() {
  watchIdle();
  bindBot(renderBot);

  try {
    const data = await (await fetch('/api/board')).json();
    token = data.token;
    connected = true;
    setState(data, { first: true });
  } catch {
    // つながっていないことは、係の姿勢（休止中）と紙の両方で言う
    connected = false;
    clearFlash();
    renderBot();
    $('paper').replaceChildren(el('div', { class: 'clear-stage' }, [
      el('div', { class: 'big', text: 'サーバにつながりません' }),
      el('div', { class: 'sub', text: 'ターミナルで ai-work-board が動いているか確認してください。' }),
    ]));
    return;
  }

  // 板のファイルは Claude も直接書く。画面の操作だけ見ていては足りない
  const stream = new EventSource('/api/stream');
  stream.addEventListener('board', (ev) => {
    try { setState({ ...JSON.parse(ev.data), token }); } catch { /* 壊れたフレームは捨てる */ }
  });
  // 途中で落ちたら、係が寝て気づけるようにする（数字だけ古いまま、を作らない）
  stream.addEventListener('error', () => {
    if (stream.readyState === EventSource.CLOSED && connected) { connected = false; renderBot(); }
  });
  stream.addEventListener('open', async () => {
    if (connected) return;
    /*
     * つなぎ直したときは、盤面だけでなく **合言葉も取り直す**。
     *
     * サーバを立ち上げ直すと合言葉（CSRF トークン）は新しくなるが、
     * 通知で届くのは板の中身だけ。手元の合言葉は古いままなので、画面は
     * 正常に見えたまま、以後の書き込みが全部「トークンが違う」で弾かれる。
     * 原因が画面から分からないのが一番まずい。
     */
    try {
      const data = await (await fetch('/api/board')).json();
      token = data.token;
      connected = true;
      setState({ ...data, token });
    } catch {
      // まだ繋がっていないなら、次の open でやり直す
    }
  });

  $('stage').focus();
}

boot();
// 「○分待ち」は時間で変わる。ただし打っている最中は触らない
setInterval(() => {
  if (state && !shelfTab && !isTyping()) { renderTitle(); renderStage(); renderBot(); }
}, 60000);
