/**
 * 受付 — Claude から来た1件を、大きく1枚だけ出す。
 *
 * 語彙と操作は 社内で実運用しているデスクに合わせてある。種類（判断・確認・作業依頼・
 * 共有）と優先度を小さな札で示し、本文を読み、そのまま下で答える。
 * 答えると「Claude 待ち」になり、受付から外れる。
 */

import { el, chip, waited, ago, entrySource, enterGuard, text as richText } from '../ui.mjs';

const KIND_CLASS = { decision: 'kind-decision', confirm: 'kind-confirm', action: 'kind-action', fyi: 'kind-fyi' };

/** 中身の量に合わせて背を伸ばす。文面を直す用途で行数固定だと全体が見えない。 */
function grow(box) {
  box.style.height = 'auto';
  box.style.height = `${Math.min(220, Math.max(box.scrollHeight + 2, 54))}px`;
}

/**
 * 答え欄に持っていく本文。
 * 「---」のような区切りから下は、たいてい読み手（人間）への注記であって
 * 返信文の一部ではない。丸ごと入れると案内文まで送り返すので、区切りで切る。
 */
function quotableBody(body) {
  const lines = String(body).split('\n');
  const at = lines.findIndex((l) => /^\s*(?:[-–—―_*]{3,})\s*$/.test(l));
  const head = (at > 0 ? lines.slice(0, at) : lines).join('\n').trim();
  return head || null;
}

/** これまでのやりとり。1件の中に往復が積まれる。 */
function thread(item) {
  if (!(item.replies ?? []).length) return null;
  return el('div', { class: 'thread' }, item.replies.map((r) => el('div', {
    class: `turn ${r.who === 'claude' ? 'them' : 'you'}`,
  }, [
    el('div', { class: 'turn-head' }, [
      el('span', { class: 'who', text: r.who === 'claude' ? 'Claude' : 'あなた' }),
      el('span', { class: 'at', text: ago(r.at) ?? '' }),
    ]),
    richText('turn-body', r.text),
  ])));
}

function reply(item, api, hasChoices) {
  const box = el('textarea', {
    rows: hasChoices ? '2' : '3',
    placeholder: hasChoices ? '選択肢以外の答えを書く' : 'コメント',
    'aria-label': 'コメント',
  });
  box.value = api.draft(item.id);

  const watchers = [];
  box.addEventListener('input', () => {
    api.keepDraft(item.id, box.value);
    grow(box);
    for (const fn of watchers) fn();
  });
  queueMicrotask(() => grow(box));

  // デスクと同じ「この回答で完了にする」。既定は Claude 待ちにするだけ
  let closing = false;
  const closeToggle = el('button', {
    class: 'toggle', type: 'button', 'aria-pressed': 'false',
    'aria-label': 'この回答で完了にする',
    title: '通常は回答しても「Claude の番」に残ります。ここを入れると、回答と同時に完了にします',
  }, [
    el('span', { class: 'tick', 'aria-hidden': 'true' }),
    el('span', { text: 'この回答で完了にする' }),
  ]);
  closeToggle.addEventListener('click', () => {
    closing = !closing;
    closeToggle.classList.toggle('on', closing);
    closeToggle.setAttribute('aria-pressed', String(closing));
  });

  const send = el('button', { class: 'go', type: 'button', text: '回答する' });

  const submit = async () => {
    const v = box.value.trim();
    if (!v) {
      box.focus();
      api.toast(hasChoices ? '選択肢を押すか、コメントを書いてください' : 'コメントを書いてから押してください');
      return;
    }
    send.disabled = true;
    try {
      await api.answer(item.id, v, { close: closing });
    } finally {
      send.disabled = false;
    }
  };

  send.addEventListener('click', submit);
  const composing = enterGuard(box);
  box.addEventListener('keydown', (e) => {
    // ⌘Enter でも、変換中なら送らない（環境によって修飾キーごと届く）
    if (composing(e)) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });

  return {
    node: el('div', { class: 'reply' }, [
      box,
      el('div', { class: 'row' }, [
        send,
        closeToggle,
        el('span', { class: 'hint', text: '⌘Enter で送信' }),
      ]),
    ]),
    value: () => box.value,
    onChange: (fn) => watchers.push(fn),
    focus: () => { box.focus(); box.scrollIntoView({ block: 'nearest' }); },
    fill: (v) => {
      box.value = v;
      api.keepDraft(item.id, v);
      grow(box);
      for (const fn of watchers) fn();
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      box.scrollIntoView({ block: 'nearest' });
    },
    isClosing: () => closing,
  };
}

/** 1件ぶんの紙。 */
export function sheet(item, api, sessionName = null, { swapped = true } = {}) {
  const options = Array.isArray(item.options) ? item.options : [];
  const w = waited(item.created);

  /**
   * 前の1件に答えた流れで、次の1件に答えてしまわないようにする。
   * 紙は同じ枠に同じ見た目で入れ替わり、選択肢の位置もほぼ重なるので、
   * 同じ場所を続けて叩くと読んでいない件に答えが確定する。
   * ただし「1回目を捨てる」はしない。直前の操作の続きかだけを見る。
   */
  const SAME_GESTURE_MS = 600;

  function isCarriedOver(kind, at) {
    const last = api.lastAnswer();
    if (!last || Date.now() - last.at > SAME_GESTURE_MS) return false;
    if (kind === 'key') return last.kind === 'key' && last.key === at;
    return last.kind === 'click' && Math.abs(last.y - at) < 24;
  }

  function refuse() {
    api.toast('続けて押されたので止めました。内容を読んでから、もう一度どうぞ');
    node?.classList.add('nudge');
    setTimeout(() => node?.classList.remove('nudge'), 400);
  }

  /**
   * 選択肢とコメントは一緒に送る。
   *
   * 選ぶ理由を書いてから選択肢を押す、は普通にやる操作。そこでコメントを
   * 捨てると、相手が Claude なだけに一番大事な「なぜそうするか」が消える。
   */
  const withComment = (opt) => {
    const note = r.value().trim();
    return note ? `${opt}\n\n${note}` : opt;
  };

  const choiceButtons = options.map((opt, i) => el('button', {
    class: 'choice', type: 'button',
    onclick: (e) => {
      if (isCarriedOver('click', e.clientY)) { refuse(); return; }
      e.currentTarget.disabled = true;
      api.answer(item.id, withComment(opt), { close: r.isClosing(), gesture: { kind: 'click', y: e.clientY } });
    },
  }, [
    el('span', { class: 'num', text: String(i + 1) }),
    el('span', { text: opt }),
  ]));

  const r = reply(item, api, options.length > 0);

  // 「この文面でいいですか」型は、本文を直して返すのが自然な答え方になる
  const quotable = options.length === 0 && item.body && item.body.length <= 2000
    ? quotableBody(item.body)
    : null;
  const carryOver = quotable
    ? (() => {
      const b = el('button', { class: 'quiet carry', type: 'button' });
      const refresh = () => {
        const dirty = r.value().trim();
        b.textContent = dirty && dirty !== quotable.trim()
          ? '書いたものを捨てて、本文に戻す'
          : '本文をコメント欄に入れて直す';
      };
      b.addEventListener('click', () => { r.fill(quotable); refresh(); });
      r.onChange(refresh);
      queueMicrotask(refresh);
      return b;
    })()
    : null;

  const scroll = el('div', { class: 'sheet-scroll' }, [
    el('div', { class: 'kicker' }, [
      chip(item.kindLabel ?? 'スレッド', KIND_CLASS[item.kind] ?? ''),
      item.priority === 'high' ? chip('至急', 'urgent') : null,
      // 新しいスレッドと、こちらが答えたあとの返信は、読み方がまったく違う
      (item.replies ?? []).at(-1)?.who === 'claude' && (item.replies ?? []).length > 1
        ? chip('返信あり', 'me') : null,
      w ? chip(w, 'wait') : null,
      item.project ? chip(item.project) : null,
      sessionName ? chip(sessionName, 'soft') : null,
    ]),
    el('h1', { text: item.title ?? '（見出しがありません）' }),
    item.body ? richText('lede', item.body) : null,
    thread(item),
    carryOver,
    entrySource(item, api),
  ]);

  const answer = el('div', { class: 'answer' }, [
    el('div', {
      class: 'lead',
      text: options.length
        ? '押すとすぐ回答になります。書きかけのコメントも一緒に送られます（押し間違えても「Claude の番」から受付に戻せます）'
        : 'コメントを書いて回答する',
    }),
    options.length ? el('div', { class: 'choices' }, choiceButtons) : null,
    r.node,
  ]);

  // 入れ替えの合図は、本当に別の紙になったときだけ。同じ紙が描き直される
  // たびに瞬かせると、1回答えただけで画面がチカチカする
  const node = el('article', { class: `sheet${swapped ? ' swapping' : ''}` }, [scroll, answer]);
  if (swapped) setTimeout(() => node.classList.remove('swapping'), 280);

  return {
    node,
    focusReply: r.focus,
    choose: (i) => {
      const b = choiceButtons[i];
      if (!b || b.disabled) return false;
      if (isCarriedOver('key', String(i + 1))) { refuse(); return true; }
      b.disabled = true;
      api.answer(item.id, withComment(options[i]), { close: r.isClosing(), gesture: { kind: 'key', key: String(i + 1) } });
      return true;
    },
  };
}

/**
 * 受付が空のときの画面。
 *
 * 「0件です」で終わらせない。片付いたことが見えて、いま何が動いているかが
 * 静かに分かるところまでを1画面にする。
 */
export function clearStage(state, api) {
  const sessions = state.sessions?.sessions ?? [];
  const live = sessions.filter((s) => s.status === 'busy' || s.status === 'waiting' || s.state === 'blocked');
  const waitingOnes = live.filter((s) => s.status === 'waiting' || s.state === 'blocked');
  const busyOnes = live.filter((s) => !(s.status === 'waiting' || s.state === 'blocked'));

  const row = (s) => el('div', { class: 'row', title: s.cwd ?? '' }, [
    el('span', { class: `dot ${s.status === 'waiting' || s.state === 'blocked' ? 'wait' : 'busy'}` }),
    el('span', { class: 'who', text: s.name ?? s.sessionId.slice(0, 8) }),
    s.cwd ? el('span', { class: 'where', text: s.cwd.replace(/^.*\/(?=[^/]+$)/, '') }) : null,
    el('button', {
      class: 'tiny', type: 'button',
      title: 'このセッションを開くコマンドをクリップボードにコピーします',
      text: 'コマンドをコピー',
      onclick: (ev) => api.copyResume(s, ev.currentTarget),
    }),
  ]);

  const group = (label, list) => (list.length
    ? el('div', { class: 'group' }, [
      el('div', { class: 'group-label', text: label }),
      el('div', { class: 'rows' }, list.slice(0, 6).map(row)),
    ])
    : null);

  // 「板が空」が信じられる状態かを、この画面で切り分けられるようにする。
  // Claude が一度も書いていないなら、スレッドが無いのではなく設定が効いていない
  const everWrote = (state.theirs ?? []).some((e) => e.from === 'claude')
    || (state.closed ?? []).some((e) => e.from === 'claude')
    || (state.tasks?.lanes ?? []).some((l) => l.tasks.length > 0);

  return el('div', { class: 'clear-stage' }, [
    el('div', { class: 'big', text: '受付は空です' }),
    el('div', {
      class: 'sub',
      text: waitingOnes.length
        ? `ただし、ターミナル側で入力待ちのセッションが${waitingOnes.length}本あります。板に出てこない質問はそちらにあります。`
        : (busyOnes.length
          ? 'Claude が作業を続けています。聞きたいことができたら、ここに出ます。'
          : 'Claude から新しいスレッドが来ると、ここに出ます。'),
    }),
    group('ターミナルで入力待ち', waitingOnes),
    group('作業中', busyOnes),
    !state.demo && !everWrote
      ? el('div', { class: 'setup-hint' }, [
        el('div', { text: 'Claude がこの板にまだ一度も書いていません。' }),
        el('div', { text: 'スレッドが無いのか、設定がまだなのか分かれるところなので、確かめてください:' }),
        el('code', { text: 'templates/CLAUDE.board.md を自分の CLAUDE.md に貼るか @ で読み込ませる' }),
      ])
      : null,
    el('button', { class: 'quiet', type: 'button', text: 'Claude にスレッドを立てる', onclick: () => api.openShelf('new') }),
  ]);
}
