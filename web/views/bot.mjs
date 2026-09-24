/**
 * 係。
 *
 * 画面の左に立っていて、Claude から来た紙を運んでくる。やっていることは
 * 「いまの状態を一言にする」だけだが、それを文字の前に姿勢で出す。
 *
 * ここが受け持つのは3つ。
 *   1. いまの状態 → ポーズと一言（mood）
 *   2. 新しく届いたとき → 歩いてきて紙を差し出す（playDelivery）
 *   3. 答えた直後 → 一瞬だけ返事を出す（botFlash）
 *
 * 動きは全部ただの飾りなので、止まっても中身は読める。reduced-motion の人と
 * 裏に回っているタブでは、最初から動かさない。
 */

import { el, ellipsizeMiddle } from '../ui.mjs';
import { bodyArt, art } from '../art.mjs';

/** 目を通した紙。読んだものを「新着」と言い続けないため。 */
const seen = new Set();
export function markSeen(id) { if (id) seen.add(id); }

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── いまの状態をひとことに ───────────────── */

const short = (s) => ellipsizeMiddle(String(s ?? ''), 22);

function termWaits(state) {
  return (state?.sessions?.sessions ?? [])
    .filter((s) => s.status === 'waiting' || s.state === 'blocked').length;
}

/**
 * ポーズと一言。
 *
 * `tone` は 'hot'（手を止めてほしい）/ 'done'（片付いている）だけ。
 * `act` があると、係を押したときにその紙へ飛ぶ。
 */
export function mood(state, { connected = true } = {}) {
  if (!connected) return { pose: 'sleep', line: 'サーバーにつながっていません', sub: 'ターミナルの ai-work-board を確認してください', tone: 'hot' };
  if (!state) return { pose: 'wait', line: '板を開いています…' };

  const list = state.waiting ?? [];
  const terms = termWaits(state);
  const theirs = (state.theirs ?? []).length;

  if (list.length === 0) {
    if (terms) {
      return {
        pose: 'wait', tone: 'hot',
        line: '受付は空です',
        sub: `ただしターミナルで${terms}本が入力待ちです`,
        go: 'now',
      };
    }
    // 一度も使われていない板で「お疲れさまでした」と言うと、
    // 「自分は何か終えたことになっているのか」と読まれる（初見レビュー m-11）
    const used = theirs > 0
      || (state.closed ?? []).length > 0
      || (state.tasks?.lanes ?? []).some((l) => l.tasks.length > 0);
    return {
      pose: 'relax', tone: 'done',
      line: '受付は空です',
      sub: theirs ? `Claude が${theirs}件おあずかり中です`
        : (used ? 'お疲れさまでした' : 'まだ何も届いていません'),
      go: theirs ? 'theirs' : null,
    };
  }

  /**
   * 「いま受付に何件あるか」は、どの言い方をしていても必ず出す。
   *
   * 上の帯を無くしたので、件数を言う場所がここしか無い。新着の話だけを
   * していると「で、残りいくつ？」に画面のどこも答えなくなる（初見レビュー M-2）。
   */
  const n = list.length;
  const total = n > 1 ? `受付は全部で${n}件です` : null;

  const hot = list.filter((e) => e.priority === 'high');
  if (hot.length) {
    return {
      pose: 'rush', tone: 'hot',
      line: `至急を${hot.length}件おもちしました`,
      sub: total ? `${total}。先に目を通してください` : '先に目を通してください',
      act: hot[0].id,
    };
  }

  const fresh = list.filter((e) => !seen.has(e.id));
  if (fresh.length > 1) {
    return {
      pose: 'bundle',
      line: `スレッドの通知が${fresh.length}件あります`,
      sub: total ? `${total}。上から順に読めます` : '上から順に読めます',
      act: fresh[0].id,
    };
  }
  if (fresh.length === 1) {
    return {
      pose: 'deliver',
      line: 'スレッドの通知が1件あります',
      sub: total ?? `Claude から「${short(fresh[0].title)}」`,
      act: fresh[0].id,
    };
  }
  return {
    pose: 'wait',
    line: `${n}件、お返事をお待ちしています`,
    sub: terms ? `ターミナルでも${terms}本が入力待ちです` : '急ぎのものはありません',
    ...(terms ? { tone: 'hot', go: 'now' } : {}),
  };
}

/* ── 一瞬だけ差し込む返事 ─────────────────── */

let flashSpec = null;
let flashTimer = null;
let repaint = () => {};

/** 係を描き直したいときに呼んでもらう口。app 側から1回だけ渡す。 */
export function bindBot(fn) { repaint = fn; }

/**
 * 答えた直後の返事。
 *
 * 「送れたか分からない」が一番不安なので、トーストとは別に係にも出す。
 * 画面の下と左で2回言うことになるが、目が行っている方で必ず拾える。
 */
export function botFlash(spec, ms = 2400) {
  flashSpec = spec;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashSpec = null; repaint(); }, ms);
  repaint();
}

export function clearFlash() {
  flashSpec = null;
  clearTimeout(flashTimer);
}

/* ── 描く ─────────────────────────────────── */

/**
 * 係そのもの。押すと、いま言っていることの現物へ連れていく。
 * 「何か言っているが、どこを見ればいいか分からない」を作らない。
 */
export function bot(state, api, { connected = true, cursorId = null } = {}) {
  const spec = flashSpec ?? mood(state, { connected });

  // いま開いている紙を指しているなら、それは「連れていく先」ではない。
  // 押しても何も起きない見た目のままだと、飾りを押しただけに見える（M-3）
  const act = spec.act && spec.act !== cursorId ? spec.act : null;
  const cta = act ? 'そのスレッドを開く' : (spec.go ? '一覧を開く' : null);

  const figure = bodyArt(spec.pose);
  if (flying > 0) figure.classList.add('away');

  const host = el('button', {
    class: `bot-side${cta ? '' : ' idle'}`, type: 'button',
    // 同じことを言っている間は描き直さないための印（app 側が見る）
    'data-sig': JSON.stringify([spec.pose, spec.line, spec.sub ?? '', spec.tone ?? '', act, spec.go ?? '', flying > 0]),
    'data-pose': spec.pose,
    'data-tone': spec.tone ?? '',
    disabled: !cta,
    'aria-label': `係: ${spec.line}${spec.sub ? `（${spec.sub}）` : ''}${cta ? `。押すと${cta}` : ''}`,
    title: cta ? `押すと${cta}` : '',
    onclick: () => {
      if (act) api.goTo(act);
      else if (spec.go) api.openShelf(spec.go);
    },
  }, [
    el('span', { class: 'bot-bubble', 'aria-hidden': 'true' }, [
      el('span', { class: 'bot-line', text: spec.line }),
      spec.sub ? el('span', { class: 'bot-sub', text: spec.sub }) : null,
      cta ? el('span', { class: 'bot-go', text: `→ ${cta}` }) : null,
    ]),
    figure,
  ]);
  return host;
}

/* ── 配達 ─────────────────────────────────── */

const fxLayer = () => document.getElementById('fx');

/**
 * いま歩いている係の数。
 *
 * 配達の途中で板が更新されると、立ち位置の絵が作り直される。そのとき
 * 「席を空けている」印が新しい絵に付かないと、歩いている本人と席の本人が
 * 同時に映って2人になる。数えておいて、描くたびに付け直す。
 */
let flying = 0;

/* 裏で届いたぶん。見えたときにまとめて1回運ぶ */
let queued = [];
let listening = false;
const QUEUE_MAX = 20;

/**
 * 新しい紙が届いたところ。
 *
 * 係が画面の外から歩いてきて、立ち位置に着き、持ってきた紙を「いま見る場所」へ
 * 差し出す。ポーリング1回ぶんをまとめて1回だけ動かす。1件ごとに動かすと、
 * まとめて届いた朝に何度も同じ動きを見ることになる。
 *
 * 【裏のタブで届いたとき】
 * このツールの届き方は、ほとんどが「ターミナルで作業している間に裏で届く」。
 * そこで捨ててしまうと、配達はほぼ一生見られないものになる。預かっておいて、
 * 画面がこちらを向いたときに運ぶ。そのとき既に片付いているものは省く。
 *
 * reduced-motion の人には最初から動かさない。動かなくても紙はもう画面に
 * あるので、情報は落ちない。
 */
export function playDelivery(fresh, { reveal = false, alive = null } = {}) {
  if (!fresh?.length || still()) return;

  if (document.hidden) {
    const have = new Set(queued.map((e) => e.id));
    for (const e of fresh) if (!have.has(e.id)) queued.push(e);
    if (queued.length > QUEUE_MAX) queued = queued.slice(-QUEUE_MAX);
    if (!listening) {
      listening = true;
      document.addEventListener('visibilitychange', function onShow() {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', onShow);
        listening = false;
        const batch = queued;
        queued = [];
        // 見ていない間に片付いたものは、もう運ばない
        const live = alive ? alive(batch) : batch;
        // 画面が描き直されてから運ぶ。差し出す先が決まっていないと動かせない
        if (live.length) requestAnimationFrame(() => walkIn(live, { reveal: false }));
      });
    }
    return;
  }
  walkIn(fresh, { reveal });
}

/** 実際に歩かせる。ここに来る時点で「動かしてよい・画面は見えている」。 */
function walkIn(fresh, { reveal = false } = {}) {
  const fx = fxLayer();
  const seat = document.querySelector('.bot-side .bot-art');
  const target = document.querySelector('.sheet') ?? document.querySelector('.clear-stage');
  if (!fx || !seat || !target) return;

  const r = seat.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  if (!r.width || !tr.width) return;

  const n = fresh.length;
  const rush = fresh.some((e) => e.priority === 'high');
  const sheets = Math.min(n, 3);
  const sym = rush ? 'rush' : (n > 1 ? 'bundle' : 'deliver');

  const g = el('div', { class: 'fx-bot' });
  g.style.width = `${r.width}px`;
  g.style.height = `${r.height}px`;
  g.appendChild(bodyArt(sym, 'bot-art'));
  fx.appendChild(g);

  const x1 = Math.round(r.left);
  const y = Math.round(r.top);
  const x0 = -r.width - 16;
  const walk = rush ? 640 : 940;
  const beat = 200;
  const total = walk + (sheets - 1) * beat + 580;

  // 歩き・お辞儀・立ち止まりを1本のキーフレームにまとめる。
  // transform を複数のアニメで取り合うと、待っている間の値が競合して歩きが消える
  const kf = [];
  const push = (ms, x, lift, tilt, easing) => kf.push({
    offset: Math.min(1, Math.max(0, ms / total)),
    transform: `translate(${Math.round(x)}px, ${Math.round(y - lift)}px) rotate(${tilt + (rush ? -4 : 0)}deg)`,
    ...(easing ? { easing } : {}),
  });
  const STEPS = 6;
  for (let i = 0; i <= STEPS; i++) {
    const p = i / STEPS;
    push(walk * p, x0 + (x1 - x0) * p, i % 2 ? 5 : 0, i % 4 === 1 ? -2.5 : i % 4 === 3 ? 2.5 : 0, 'ease-out');
  }
  for (let i = 0; i < sheets; i++) {       // 1枚ずつ差し出す
    const t0 = walk + i * beat;
    push(t0 + 70, x1 + 6, -3, -8, 'ease-out');
    push(t0 + 170, x1, 0, 0, 'ease-in-out');
  }
  push(total, x1, 0, 0);

  flying += 1;
  seat.classList.add('away');
  const move = g.animate(kf, { duration: total, fill: 'forwards' });
  move.finished.catch(() => {}).finally(() => {
    flying = Math.max(0, flying - 1);
    g.remove();
    // 描き直されていると、いまの席は最初に掴んだものではない
    if (!flying) document.querySelector('.bot-side .bot-art')?.classList.remove('away');
  });

  const hand = { x: x1 + r.width * 0.55, y: y + r.height * 0.3 };
  const spot = {
    x: Math.round(tr.left + tr.width / 2 - 24),
    y: Math.round(tr.top + Math.min(120, tr.height * 0.3)),
  };
  for (let i = 0; i < sheets; i++) dropSheet(hand, spot, rush && i === 0, walk + i * beat + 60);

  // 開いた直後は、差し出された瞬間に紙の本体が現れるようにする
  if (reveal && target.classList.contains('sheet')) {
    target.animate(
      [{ opacity: 0, transform: 'translateY(8px) scale(.99)' }, { opacity: 1, transform: 'none' }],
      { duration: 280, delay: walk + (sheets - 1) * beat + 380, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' },
    );
  }
}

/** 紙1枚が、係の手から「いま見る場所」へ飛ぶ。至急のものは赤くする。 */
function dropSheet(from, to, hot, delay) {
  const fx = fxLayer();
  if (!fx) return;
  const d = el('div', { class: `fx-sheet${hot ? ' hot' : ''}` });
  d.appendChild(art('sheet', { viewBox: '0 0 48 60' }));
  fx.appendChild(d);
  const mx = Math.round((from.x + to.x) / 2);
  const my = Math.round(Math.min(from.y, to.y) - 40);
  const a = d.animate([
    { transform: `translate(${Math.round(from.x)}px, ${Math.round(from.y)}px) rotate(-10deg) scale(.7)`, opacity: 0 },
    { transform: `translate(${mx}px, ${my}px) rotate(5deg) scale(1)`, opacity: 1, offset: .4 },
    { transform: `translate(${to.x}px, ${to.y}px) rotate(0deg) scale(1.25)`, opacity: .9, offset: .88 },
    { transform: `translate(${to.x}px, ${to.y}px) rotate(0deg) scale(1.5)`, opacity: 0 },
  ], { duration: 560, delay, easing: 'cubic-bezier(.35,.05,.4,1)', fill: 'backwards' });
  a.finished.catch(() => {}).finally(() => d.remove());
}

/* ── 動きを止める ─────────────────────────────
 * 1日中開けたままにするものなので、触っていない間は動かさない。
 * 止まっても姿勢は残るので、状態は読める。
 */
const STILL_MS = 30000;
let lastInput = 0;

export function watchIdle() {
  const wake = () => {
    lastInput = performance.now();
    document.documentElement.classList.remove('still');
  };
  let lastPt = '';
  // 描画が変わるだけで pointermove が飛ぶことがあるので、位置が動いた時だけ
  addEventListener('pointermove', (e) => {
    const k = `${e.clientX},${e.clientY}`;
    if (k !== lastPt) { lastPt = k; wake(); }
  }, { capture: true, passive: true });
  for (const ev of ['pointerdown', 'keydown', 'wheel']) {
    addEventListener(ev, wake, { capture: true, passive: true });
  }
  wake();
  setInterval(() => {
    if (performance.now() - lastInput >= STILL_MS) document.documentElement.classList.add('still');
  }, 1000);
}
