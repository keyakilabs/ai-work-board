/**
 * `--demo` で出すサンプル。
 *
 * このモードはローカルのファイルを一切読まない。板がどんなものかを、
 * 自分のデータを見せる前に確かめられるようにするため。
 */

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();

const base = {
  where: 'items', broken: false, options: [], links: [], replies: [],
  answer: '', answered_at: '', closed_at: '', origin: '', due: '',
};

export function demoBoard() {
  return {
    // あなた待ち（open）。優先度が高いもの・古いものから
    waiting: [
      {
        ...base,
        id: 'demo-1', kind: 'decision', kindLabel: '判断',
        title: '請求の丸め方をどちらにしますか',
        priority: 'high', status: 'open', project: 'billing', from: 'claude',
        created: iso(52), updated: iso(52),
        options: ['切り捨て（今の実装のまま）', '四捨五入（会計側に合わせる）'],
        body: '明細ごとに丸めるか合計で丸めるかで、月末の合計が最大3円ずれます。\n'
          + '会計側は四捨五入なので、そちらに合わせると突合が楽になります。\n\n'
          + '## あなたにお願いしたいこと\n\n'
          + '1. どちらに寄せるかを決める\n'
          + '2. 決まり次第こちらで直し、テストを足して報告します',
      },
      {
        ...base,
        id: 'demo-2', kind: 'confirm', kindLabel: '確認',
        title: '古い連携APIを落としていいですか',
        priority: 'normal', status: 'open', project: 'forms', from: 'claude',
        created: iso(11), updated: iso(11),
        options: ['落とす', '残す', '告知してから落とす'],
        body: '過去30日でアクセスは0件でした。落とすとコードが200行減ります。',
      },
      {
        ...base,
        id: 'demo-3', kind: 'action', kindLabel: '作業依頼',
        title: '先方への返信文はこれでいいですか',
        priority: 'normal', status: 'open', project: 'blog', from: 'claude',
        created: iso(4), updated: iso(4),
        body: 'お世話になっております。\n'
          + 'ご指摘の件、確認したところ設定の反映が漏れておりました。\n'
          + '本日中に修正し、改めてご連絡いたします。\n\n'
          + '---\n'
          + '選択肢は用意していません。直したいところがあれば書き換えてください。',
      },
    ],

    // Claude 待ち（answered）。答え終わっていて、あとは向こうが動く番
    theirs: [
      {
        ...base,
        id: 'demo-4', kind: 'action', kindLabel: '作業依頼',
        title: '請求書のPDFだけ先に出せるようにして',
        priority: 'normal', status: 'answered', project: 'billing', from: 'you',
        created: iso(180), updated: iso(96), answered_at: iso(96), origin: 'board-ui',
        answer: '締めの処理は後でいい。PDFが出れば手で送れる',
        body: '金曜までに使いたいです。',
        replies: [{ who: 'you', at: iso(96), text: '締めの処理は後でいい。PDFが出れば手で送れる' }],
      },
    ],

    closed: [
      {
        ...base, where: 'closed',
        id: 'demo-5', kind: 'decision', kindLabel: '判断',
        title: '本番への昇格は必ず人が承認する',
        priority: 'high', status: 'closed', project: 'billing', from: 'claude',
        created: iso(1600), updated: iso(1580), answered_at: iso(1580), closed_at: iso(1580),
        answer: '人が承認する。PRを出すところまでは自動でよい',
        body: '自動昇格は事故ったときに戻せません。',
        replies: [{ who: 'you', at: iso(1580), text: '人が承認する。PRを出すところまでは自動でよい' }],
      },
    ],

    broken: [],

    tasks: {
      doneDays: 7,
      lanes: [
        {
          key: 'doing',
          label: '着手中',
          tasks: [
            {
              id: 'demo-task-1', lane: 'doing', project: 'billing',
              title: '請求まわりのリファクタ',
              now: '明細の計算をテストで固めた（38件パス）。次は丸めの方針が決まり次第、合計側を直す',
              updated: iso(4),
            },
          ],
        },
        {
          key: 'inbox',
          label: '未着手',
          tasks: [
            {
              id: 'demo-task-2', lane: 'inbox', project: 'forms',
              title: '古い連携APIの撤去',
              now: '「落としていいか」の判断待ち',
              updated: iso(11),
            },
          ],
        },
        {
          key: 'done',
          label: '完了',
          tasks: [
            {
              id: 'demo-task-3', lane: 'done', project: 'blog',
              title: '記事の下書きを1本',
              now: '公開まで完了',
              updated: iso(900),
            },
          ],
        },
      ],
    },
  };
}

export function demoSessions() {
  return {
    available: true,
    why: '',
    command: 'claude agents --json',
    sessions: [
      {
        sessionId: 'demo-a', name: 'billing-rounding', cwd: '/Users/you/repos/billing',
        status: 'waiting', state: 'blocked', waitingFor: 'input needed', pid: 12345,
        startedAt: Date.now() - 60 * 60000, rank: 0,
        lastPrompt: '請求の明細をテストで固めてから合計を直して', lastPromptWhy: '',
        source: { state: 'claude agents --json', prompt: null, tailBytes: 262144 },
      },
      {
        sessionId: 'demo-b', name: 'forms-intake', cwd: '/Users/you/repos/forms',
        status: 'busy', state: 'working', waitingFor: null, pid: 12346,
        startedAt: Date.now() - 25 * 60000, rank: 1,
        lastPrompt: '古い連携APIの利用状況を調べて', lastPromptWhy: '',
        source: { state: 'claude agents --json', prompt: null, tailBytes: 262144 },
      },
      {
        sessionId: 'demo-c', name: 'blog-draft', cwd: '/Users/you/work',
        status: 'idle', state: 'done', waitingFor: null, pid: 12347,
        startedAt: Date.now() - 180 * 60000, rank: 2,
        lastPrompt: null, lastPromptWhy: 'ログの末尾に直近の指示が残っていない',
        source: { state: 'claude agents --json', prompt: null, tailBytes: 262144 },
      },
    ],
  };
}
