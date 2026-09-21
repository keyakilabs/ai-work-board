/**
 * 絵の部品。
 *
 * この板には「係」が1人いて、Claude から来た紙を運んでくる。数字と文字だけの
 * 画面だと、何件たまっているかは分かっても「いま自分は追われているのか、
 * 落ち着いているのか」が読み取れない。姿勢で先に伝えて、文字は確認に回す。
 *
 * 絵は全部ここに書いた線画で、外の画像は一切読み込まない。
 *
 * 【CSP と、`<symbol>` + `<use>` を使わない理由】
 * この画面は `style-src 'self'` で動いていて、`style="fill:…"` のような
 * 属性はブラウザに弾かれる。だから色は CSS 側（style.css の `.art …`）で
 * 当てる。ところが `<use>` で参照した中身はシャドウツリーに入るので、
 * 外の CSS セレクタが届かない。結果、部品は使い回すが、出すときは
 * 毎回この文字列から実物の DOM を組む。
 *
 * ここで組み立てる文字列は全部この場の定数で、板の中身は一切混ざらない。
 */

const NS = 'http://www.w3.org/2000/svg';

/* ── 体の部品。ポーズごとに描き直すと、同じ人に見えなくなる ── */

const HEAD = `
  <rect class="body" x="41" y="28" width="38" height="34" rx="11"/>
  <path d="M60 28V20"/>
  <circle class="dot" cx="60" cy="16.5" r="3.2"/>`;

const FACE = `
  <circle class="solid" cx="52" cy="44" r="3.1"/>
  <circle class="solid" cx="68" cy="44" r="3.1"/>
  <path class="thin" d="M55.5 51.5q4.5 3.8 9 0"/>`;

const FACE_SHUT = `<path class="mid" d="M48.5 44.5q3.5 3.2 7 0M65.5 44.5q3.5 3.2 7 0"/>`;

const TORSO = `
  <rect class="body" x="45" y="64" width="30" height="27" rx="9"/>
  <path class="thin" d="M53.5 72.5h13"/>`;

const LEGS = `<path d="M52 91v7M68 91v7"/><path d="M46.5 99h11M62.5 99h11"/>`;

/** 腕は「太い外線 + 細い内側」の2本描きで筒に見せる。 */
const arm = (d) => `<path class="arm" d="${d}"/><path class="arm-in" d="${d}"/>`;

/** 持っている紙。x,y と傾きだけ変えて使い回す。 */
const paper = (x, y, rot = 0) => `
  <g transform="translate(${x} ${y}) rotate(${rot})">
    <rect class="paper" x="0" y="0" width="30" height="20" rx="2.5"/>
    <path class="thin" d="M5 7h20M5 13h13"/>
  </g>`;

/* ── ポーズ ────────────────────────────────── */

const POSES = {
  /* 待っている。持ってきた紙はもう渡してあって、返事を待つ姿勢 */
  wait: `
    ${LEGS}
    ${arm('M47 71L36 83')}
    ${arm('M73 71L84 83')}
    ${TORSO}${HEAD}${FACE}
    <g transform="rotate(-9 86 90)">
      <rect class="paper" x="76" y="78" width="21" height="26" rx="2.5"/>
      <path class="thin" d="M80.5 86h12M80.5 92h8"/>
    </g>`,

  /* 1枚だけ届けに来た。歩いている途中なので、体を少し前に倒す */
  deliver: `
    <g transform="rotate(4 60 100)">
      ${LEGS}${TORSO}${HEAD}${FACE}
      ${arm('M46 74L47 88')}
      ${arm('M74 74L73 88')}
      ${paper(45, 84)}
    </g>
    <path class="mark" d="M14 94h9M10 102h9"/>`,

  /* 何枚も抱えている。束にすると「今日は多い」が一目で分かる */
  bundle: `
    <g transform="rotate(4 60 100)">
      ${LEGS}${TORSO}${HEAD}${FACE}
      ${arm('M46 74L46 90')}
      ${arm('M74 74L74 90')}
      ${paper(48, 78, -5)}
      ${paper(45, 84, 2)}
      ${paper(46, 90, -1)}
    </g>
    <path class="mark" d="M14 94h9M10 102h9"/>`,

  /* 至急。走っている姿と勢い線で、読む前に「急ぎ」と分かるようにする */
  rush: `
    <g transform="rotate(11 60 100)">
      ${arm('M46 72L30 64')}
      ${LEGS}${TORSO}
      <g transform="rotate(-6 60 46)">${HEAD}</g>
      ${FACE}
      ${arm('M74 72L90 60')}
      ${paper(84, 44, -16)}
    </g>
    <path class="mark" d="M4 62h13M2 74h11M6 86h10"/>`,

  /* 受付が空。湯気の立つカップを持たせて「今は何もない」を見た目で言う */
  relax: `
    ${LEGS}
    ${arm('M47 71L38 84')}
    ${arm('M73 72L82 80')}
    ${TORSO}${HEAD}${FACE}
    <path class="paper" d="M79 79h14v10a5 5 0 01-5 5h-4a5 5 0 01-5-5z"/>
    <path class="thin" d="M93 82h3a3.5 3.5 0 010 7h-3"/>
    <path class="mark thin" d="M83 74c-2-3 2-4 0-7M89 74c-2-3 2-4 0-7"/>`,

  /* つながっていない。動かない画面の理由を、姿勢で先に見せる */
  sleep: `
    ${LEGS}
    ${arm('M47 72L37 84')}
    ${arm('M73 72L83 84')}
    ${TORSO}
    <g transform="rotate(-11 60 62)">${HEAD}${FACE_SHUT}</g>
    <path class="mark" d="M84 30h9l-9 10h9M96 16h7l-7 8h7"/>`,

  /* 受け取った合図。答えたことが伝わったと分かるように、一瞬だけ出す */
  cheer: `
    ${LEGS}
    ${arm('M47 70L34 56')}
    ${arm('M73 70L86 56')}
    ${TORSO}${HEAD}${FACE}
    <path class="mark" d="M28 44l-4-6M92 44l4-6M60 12v-6"/>`,

  /* Claude へ回しに行くところ。背を向けているので顔は描かない */
  out: `
    <g transform="rotate(-4 60 100) scale(-1 1) translate(-120 0)">
      ${LEGS}
      ${arm('M46 74L47 88')}
      ${TORSO}${HEAD}
      <path class="thin" d="M50 40h20"/>
      ${arm('M74 74L73 88')}
      ${paper(45, 84)}
    </g>
    <path class="mark" d="M97 94h9M101 102h9"/>`,
};

/* ── 棚に並べる札。言葉を読まなくても場所で覚えられるように、形を離す ── */

const ICONS = {
  'tray-in': `
    <path d="M8 36v12a4 4 0 004 4h40a4 4 0 004-4V36"/>
    <path d="M8 36h12l4 6h16l4-6h12"/>
    <rect class="paper" x="23" y="6" width="18" height="18" rx="2"/>
    <path class="mark" d="M32 26v6m-4-4 4 4 4-4"/>`,
  'tray-out': `
    <path d="M8 36v12a4 4 0 004 4h40a4 4 0 004-4V36"/>
    <path d="M8 36h12l4 6h16l4-6h12"/>
    <rect class="paper" x="23" y="12" width="18" height="18" rx="2"/>
    <path class="mark" d="M32 10v-6m-4 4 4-4 4 4"/>`,
  'box-done': `
    <path class="body" d="M11 25h42v25a5 5 0 01-5 5H16a5 5 0 01-5-5z"/>
    <rect x="6" y="13" width="52" height="12" rx="2.5"/>
    <path class="mark bold" d="M23 38l7 7 12-13"/>`,
  board: `
    <rect class="body" x="5" y="9" width="54" height="38" rx="3.5"/>
    <path d="M32 47v7M25 54h14"/>
    <rect class="paper thin" x="11" y="15" width="12" height="8" rx="1.5"/>
    <rect class="paper thin" x="26" y="15" width="12" height="8" rx="1.5"/>
    <rect class="filled-mark thin" x="41" y="15" width="12" height="8" rx="1.5"/>
    <rect class="paper thin" x="11" y="28" width="12" height="8" rx="1.5"/>
    <rect class="paper thin" x="26" y="28" width="12" height="8" rx="1.5"/>`,
  seats: `
    <circle class="body" cx="18" cy="19" r="7"/>
    <circle class="body" cx="46" cy="19" r="7"/>
    <path d="M6 33h24M9 33v16M27 33v16"/>
    <path d="M34 33h24M37 33v16M55 33v16"/>`,
  pen: `
    <path class="paper" d="M14 8h22l12 12v9"/>
    <path d="M36 8v12h12"/>
    <path d="M14 8v40a4 4 0 004 4h12"/>
    <path class="mid" d="M21 28h14M21 36h9"/>
    <path class="body" d="M38 48l14-15 7 6-14 15-9 2z"/>
    <path class="mark" d="M52 33l7 6"/>`,
  keys: `
    <rect class="body" x="5" y="16" width="54" height="32" rx="5"/>
    <path class="bold" d="M14 26h4M24 26h4M34 26h4M44 26h6M14 35h6M26 35h4M36 35h4M46 35h4M22 43h20"/>`,
  sheet: `
    <rect class="paper" x="4" y="3" width="40" height="53" rx="3"/>
    <path class="mid" d="M12 16h24M12 26h24M12 36h15"/>`,

  /* 明るさの切り替え。いまどれかが絵で分かるように、3つとも形を離す */
  'theme-auto': `
    <circle class="body" cx="32" cy="32" r="15"/>
    <path class="solid" d="M32 17a15 15 0 000 30z"/>
    <path class="mid" d="M32 7v4M32 53v4M7 32h4M53 32h4"/>`,
  'theme-light': `
    <circle class="body" cx="32" cy="32" r="11"/>
    <path class="mid" d="M32 8v6M32 50v6M8 32h6M50 32h6M15.5 15.5l4.2 4.2M44.3 44.3l4.2 4.2M48.5 15.5l-4.2 4.2M19.7 44.3l-4.2 4.2"/>`,
  'theme-dark': `
    <path class="body" d="M40 9a24 24 0 100 46 29 29 0 010-46z"/>
    <circle class="solid" cx="18" cy="17" r="2"/>
    <circle class="solid" cx="11" cy="28" r="1.6"/>`,
};

/* ── 組み立て ─────────────────────────────── */

function build(markup, { cls, viewBox }) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', cls ? `art ${cls}` : 'art');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  // 流し込むのはこのファイルの定数だけ。板から来た文字列はここを通らない
  svg.innerHTML = markup;
  return svg;
}

/** 棚などに置く札。 */
export function art(name, { cls = '', viewBox = '0 0 64 64' } = {}) {
  const m = ICONS[name];
  if (!m) throw new Error(`そんな絵は無い: ${name}`);
  return build(m, { cls, viewBox });
}

/** 係の絵。体は 120 四方で描いてある。知らないポーズが来ても画面は壊さない。 */
export function bodyArt(pose, cls = 'bot-art') {
  return build(POSES[pose] ?? POSES.wait, { cls, viewBox: '0 0 120 120' });
}

/** 絵の名前の一覧（テストと、取り違えの検出用）。 */
export const POSE_NAMES = Object.keys(POSES);
export const ICON_NAMES = Object.keys(ICONS);
