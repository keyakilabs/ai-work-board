/** 画面の部品。ここに置くのは「どの画面でも同じ意味になるもの」だけ。 */

export function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

export function chip(text, cls = '') {
  return el('span', { class: `chip${cls ? ` ${cls}` : ''}`, text });
}

export function unknown(why) {
  return el('span', { class: 'unknown', text: why ? `不明（${why}）` : '不明' });
}

/**
 * 本文。
 *
 * 板は誰でも書けるので HTML としては解釈しない。ただし Claude は md の癖で
 * `**いまどこまで**` のように書いてくるので、**…** だけは太字として組む。
 * 文字列から DOM を組み立てるだけで、HTML は一切パースしない。
 */
export function text(cls, s) {
  const box = el('div', { class: cls });
  for (const block of blocks(String(s || ''))) box.append(block);
  return box;
}

/**
 * 板の本文を組む。
 *
 * 板は誰でもファイルを置けるので HTML としては解釈しない。文字列から DOM を
 * 組み立てるだけ。ただし Claude は md の癖で見出し・箇条書き・太字を書いて
 * くるので、その3つだけは読める形にする。記号がそのまま出ると読みにくい。
 */
function blocks(src) {
  const out = [];
  const lines = src.split('\n');
  let para = [];
  let list = null;

  const flushPara = () => {
    if (!para.length) return;
    out.push(inline(el('p', { class: 'p' }), para.join('\n')));
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(list);
    list = null;
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    const hr = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);

    if (hr) {
      flushPara(); flushList();
      out.push(el('hr', { class: 'hr' }));
    } else if (h) {
      flushPara(); flushList();
      out.push(inline(el(`h${Math.min(4, h[1].length + 2)}`, { class: 'h' }), h[2]));
    } else if (li) {
      flushPara();
      if (!list) list = el('ul', { class: 'ul' });
      list.append(inline(el('li'), li[1]));
    } else if (line.trim() === '') {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out;
}

/** 行の中の **太字** と `コード` だけを組む。HTML は一切パースしない。 */
function inline(node, s) {
  const re = /\*\*([^*\n]{1,120})\*\*|`([^`\n]{1,200})`/g;
  let at = 0;
  let m = re.exec(s);
  while (m) {
    if (m.index > at) node.append(document.createTextNode(s.slice(at, m.index)));
    node.append(m[1] !== undefined
      ? el('strong', { text: m[1] })
      : el('code', { text: m[2] }));
    at = m.index + m[0].length;
    m = re.exec(s);
  }
  if (at < s.length) node.append(document.createTextNode(s.slice(at)));
  return node;
}

/** 長い文字列を、末尾を殺さずに真ん中で詰める。 */
export function ellipsizeMiddle(s, max = 40) {
  const v = String(s ?? '');
  if (v.length <= max) return v;
  const head = Math.ceil((max - 1) / 2);
  return `${v.slice(0, head)}…${v.slice(v.length - (max - 1 - head))}`;
}

/* ── 時間の言い方 ─────────────────────────────
 * 「何分前か」ではなく「どれだけ待たせているか」を出したい場面があるので、
 * 言い回しを2つ持つ。数字は同じでも、読んだときの意味が変わる。
 */

function minutesSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

export function ago(iso) {
  const m = minutesSince(iso);
  if (m === null) return null;
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}日前` : `${Math.floor(d / 30)}か月前`;
}

export function waited(iso) {
  const m = minutesSince(iso);
  if (m === null) return null;
  if (m < 1) return '今きた';
  if (m < 60) return `${m}分待ち`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間待ち`;
  return `${Math.floor(h / 24)}日待ち`;
}

/**
 * 伏せ字のブロック。クリックで開く。
 * 直近の指示には業務の中身が入るので、既定では見せない。
 */
export function veil(label, body) {
  if (!body) return null;
  const n = el('div', {
    class: 'veil', role: 'button', tabindex: '0',
    title: '画面共有やスクリーンショットで漏れないよう、既定では伏せています',
    text: `${label}（伏せています・クリックで表示）`,
  });
  const show = () => {
    if (n.classList.contains('shown')) return;
    n.classList.add('shown');
    n.textContent = body;
  };
  n.addEventListener('click', show);
  n.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
  });
  return n;
}

/* ── 出どころ ─────────────────────────────────
 * 「板の正本は md であって画面は窓にすぎない」と言っている以上、その md を
 * 実際に開けないと、ただの主張になる。常時は畳むが、いつでも開ける。
 */

async function copy(value, button) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'コピーした';
    setTimeout(() => { button.textContent = label; }, 1200);
  } catch {
    // クリップボードが使えない環境では、選べる形にするところまでやる
    const ta = el('textarea', { rows: '2', style: 'width:100%;margin-top:6px;font-size:11px' });
    ta.value = value;
    button.closest('.src-note')?.after(ta);
    ta.select();
  }
}

function disclosure(label, build) {
  const caret = el('span', { class: 'caret', text: '▸' });
  const head = el('button', { class: 'src-head', type: 'button', 'aria-expanded': 'false' }, [
    caret, el('span', { class: 'src-path', text: label }),
  ]);
  const body = el('div', { class: 'src-body' });
  const wrap = el('div', { class: 'source' }, [head, body]);
  let open = false;

  head.addEventListener('click', async () => {
    open = !open;
    wrap.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    if (!open) { body.replaceChildren(); return; }
    body.replaceChildren(el('div', { class: 'src-note', text: '読んでいます…' }));
    try {
      body.replaceChildren(...await build());
    } catch (e) {
      body.replaceChildren(el('div', { class: 'src-note bad', text: `読めませんでした: ${e.message}` }));
    }
  });
  return wrap;
}

function pathRow(p) {
  return el('div', { class: 'src-note' }, [
    el('code', { text: p }),
    el('button', { class: 'tiny', type: 'button', text: 'パスをコピー', onclick: (e) => copy(p, e.target) }),
  ]);
}

/**
 * 板のファイル1件の出どころ。押すとフルパスと生の md がそのまま出る。
 * 依頼（items / closed）にもタスク（lane）にも使う。
 */
export function entrySource(entry, api) {
  const q = entry.lane
    ? { lane: entry.lane, id: entry.id }
    : { where: entry.where ?? 'items', id: entry.id };
  const label = entry.lane ? `tasks/${entry.lane}/${entry.id}.md` : `${q.where}/${entry.id}.md`;
  return disclosure(label, async () => {
    const { path: p, text: raw } = await api.raw(q);
    return [pathRow(p ?? ''), el('pre', { class: 'raw', text: raw ?? '' })];
  });
}

/** 板の外から拾ってきた値の出どころ。何を根拠に出しているかを明かす。 */
export function factSource(rows) {
  const items = rows.filter(Boolean);
  if (items.length === 0) return null;
  return disclosure('この行の出どころ', async () => items.map(([what, from]) => el('div', { class: 'src-note' }, [
    el('span', { class: 'src-what', text: what }),
    el('code', { text: from }),
    el('button', { class: 'tiny', type: 'button', text: 'コピー', onclick: (e) => copy(from, e.target) }),
  ])));
}
