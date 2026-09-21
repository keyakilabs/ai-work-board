/**
 * 「現況」欄の自動部分。
 *
 * Claude が自分で書いた現況が一番信頼できるが、書き忘れることはある。その
 * ときでも欄が空にならないように、Claude Code 自身が持っている情報から
 * 「いま何が動いているか」を組み立てる。
 *
 *   `claude agents --json`                     … 誰が動いている / 待っている
 *   ~/.claude/projects/**<sessionId>.jsonl     … そのセッションへの直近の指示
 *
 * 取れなかったものは「不明」として返す。憶測で埋めない — 板が嘘をつくと、
 * 板そのものが読まれなくなる。
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const UNKNOWN = null;

/** jsonl の末尾だけを読む。実測で 62MB のセッションログが存在した。 */
const TAIL_BYTES = 256 * 1024;

function run(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve({ ok: false, stdout: '' });
      else resolve({ ok: true, stdout });
    });
  });
}

/**
 * `claude agents --json` の1行。実機で確認したフィールド:
 *   pid / cwd / kind / startedAt / sessionId / name / status
 * 公式ドキュメントはさらに state・waitingFor を挙げている。
 * どれも「無いかもしれない」前提で読む。
 */
function readAgent(a) {
  if (!a || typeof a !== 'object') return null;
  const sessionId = typeof a.sessionId === 'string' ? a.sessionId : null;
  if (!sessionId) return null;
  return {
    sessionId,
    name: typeof a.name === 'string' ? a.name : UNKNOWN,
    cwd: typeof a.cwd === 'string' ? a.cwd : UNKNOWN,
    pid: Number.isInteger(a.pid) ? a.pid : UNKNOWN,
    startedAt: Number.isFinite(a.startedAt) ? a.startedAt : UNKNOWN,
    status: typeof a.status === 'string' ? a.status : UNKNOWN,   // busy | waiting | idle
    state: typeof a.state === 'string' ? a.state : UNKNOWN,      // working | blocked | done | ...
    waitingFor: typeof a.waitingFor === 'string' ? a.waitingFor : UNKNOWN,
  };
}

export async function listAgents() {
  const { ok, stdout } = await run('claude', ['agents', '--json']);
  if (!ok) return { available: false, agents: [], why: '`claude` コマンドが見つからないか、応答しない' };
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { available: false, agents: [], why: '`claude agents --json` の出力が読めない形式だった' };
  }
  if (!Array.isArray(parsed)) {
    return { available: false, agents: [], why: '`claude agents --json` が配列を返さなかった' };
  }
  return { available: true, agents: parsed.map(readAgent).filter(Boolean), why: '' };
}

/** cwd のスラッグ化規則は推測しない。sessionId でファイルを探す。 */
async function findTranscript(sessionId) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(root, d.name, `${sessionId}.jsonl`);
    try {
      await fs.access(file);
      return file;
    } catch { /* 次のディレクトリへ */ }
  }
  return null;
}

/**
 * 末尾から TAIL_BYTES だけ読み、直近の指示を拾う。
 * 先頭行は途中で切れている可能性があるので捨てる。
 */
async function readTail(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function readLastPrompt(sessionId) {
  const file = await findTranscript(sessionId);
  if (!file) return { prompt: UNKNOWN, transcript: UNKNOWN, why: 'セッションのログが見つからない' };
  const tail = await readTail(file);
  if (tail === null) return { prompt: UNKNOWN, transcript: file, why: 'セッションのログが読めない' };

  let prompt = UNKNOWN;
  let title = UNKNOWN;
  for (const line of tail.split('\n')) {
    if (!line.startsWith('{')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'last-prompt' && typeof rec.lastPrompt === 'string') prompt = rec.lastPrompt;
    else if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') title = rec.customTitle;
  }
  return {
    prompt,
    title,
    transcript: file,
    why: prompt === UNKNOWN ? 'ログの末尾に直近の指示が残っていない' : '',
  };
}

/** 現況欄の自動部分を組み立てる。 */
export async function collectSessions() {
  const { available, agents, why } = await listAgents();
  if (!available) return { available: false, why, command: 'claude agents --json', sessions: [] };

  const sessions = await Promise.all(agents.map(async (a) => {
    const { prompt, title, transcript, why: promptWhy } = await readLastPrompt(a.sessionId);
    return {
      ...a,
      name: a.name || title || UNKNOWN,
      lastPrompt: prompt,
      lastPromptWhy: promptWhy,
      // この行が何を根拠に出ているか。画面から辿れるようにする
      source: {
        state: 'claude agents --json',
        prompt: transcript,
        tailBytes: TAIL_BYTES,
      },
      // 待っているものを上に出したいので、ここで序列を決めておく
      rank: a.status === 'waiting' || a.state === 'blocked' ? 0 : a.status === 'busy' ? 1 : 2,
    };
  }));

  sessions.sort((x, y) => x.rank - y.rank || (y.startedAt ?? 0) - (x.startedAt ?? 0));
  return { available: true, why: '', command: 'claude agents --json', sessions };
}
