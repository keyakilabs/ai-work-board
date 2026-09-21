/**
 * この板が守っているもの。
 *
 * `127.0.0.1` に bind するのは「他の端末から届かない」だけで、「安全」では
 * ない。同じマシンのブラウザで開いた**任意のサイト**は localhost に fetch
 * できる。この板は書き込みを受け付け、その書き込みを Claude が読む。つまり
 * 守りが無ければ、広告タグ1つが Claude への指示チャネルになる。
 *
 * だから3枚重ねる:
 *   1. Host ヘッダを検査する      … DNS リバインディング（攻撃者のドメインが
 *                                   127.0.0.1 を指す）を弾く。読み取りにも掛ける
 *   2. Origin / Referer を検査する … 別オリジンからの fetch を弾く
 *   3. CSRF トークンを要求する     … 画面を実際に開いた者だけが書ける
 *
 * そして書き込み先は板の中だけに閉じる。ここを抜けられると `.board/`
 * の隣は `.claude/settings.json`（hooks = 任意コード実行）なので、1階層の
 * 脱出がそのまま致命傷になる。
 */

import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CSRF_HEADER = 'x-board-token';

export function newToken() {
  return randomBytes(32).toString('hex');
}

export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** この板が自分のものだと認めるホスト表記。 */
function allowedHosts(port) {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
}

/**
 * Host ヘッダが自分自身を指しているか。
 * 読み取りにも掛ける — 板の中身（業務の生の文脈）を他サイトに読ませない。
 */
export function hostIsOurs(req, port) {
  const host = req.headers.host;
  return typeof host === 'string' && allowedHosts(port).has(host.toLowerCase());
}

/**
 * Origin / Referer が自分自身か。
 *
 * Origin が無いリクエストは拒否する。ブラウザは同一オリジンの GET で Origin
 * を省くことがあるので、この判定は**書き込み系にだけ**掛ける。curl のように
 * Origin を付けないものも一緒に弾かれるが、それでよい — 板に書けるのは画面
 * を開いた人だけにしたい。板のファイルを直接書きたいなら md を置けばよく、
 * そちらは「画面から書いたものではない」と区別される。
 */
export function originIsOurs(req, port) {
  const ok = allowedHosts(port);
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      return ok.has(new URL(origin).host.toLowerCase());
    } catch {
      return false;
    }
  }
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer !== '') {
    try {
      return ok.has(new URL(referer).host.toLowerCase());
    } catch {
      return false;
    }
  }
  return false; // どちらも無いものは書き込ませない
}

/**
 * `id` が板のエントリ1件を指す安全な名前か。
 *
 * パスの組み立てに使う値を受け取る唯一の入口なので、ここは許可リストで守る。
 * `..` も `/` も `%2e%2e` も、そもそも文字種で落ちる。
 */
export function isSafeEntryId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= 200
    && /^[A-Za-z0-9._-]+$/.test(id)
    && !id.startsWith('.')
    && !id.includes('..');
}

/**
 * 組み立てたパスが本当に板の中に落ちているかの最終確認。
 * 文字種の検査を通ったあとでも、シンボリックリンク等で外に出る余地を潰す。
 */
export function isInside(parentDir, candidate) {
  const parent = path.resolve(parentDir) + path.sep;
  const target = path.resolve(candidate);
  return target.startsWith(parent);
}

/** 静的ファイルの配信で、web/ の外を読ませない。 */
export function safeWebPath(webRoot, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  if (rel.includes('\0')) return null;
  const file = path.resolve(webRoot, rel);
  return isInside(webRoot, file) ? file : null;
}
