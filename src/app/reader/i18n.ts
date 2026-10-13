/**
 * Reader copy in both languages, plus the small formatters that depend on language.
 * Story content lives in the issue itself; everything here is interface text.
 */

import type { AnswerStatus, L10n, Lang, RegionKey, SourceKind } from '../../shared/issue';

export const REGION_NAMES: Record<RegionKey, L10n> = {
  us: { en: 'US', zh: '美国' },
  cn: { en: 'China', zh: '中国' },
  eu: { en: 'Europe', zh: '欧洲' },
  jp: { en: 'Japan', zh: '日本' },
  other: { en: 'Elsewhere', zh: '其他地区' },
};

const LANGUAGE_NAMES: Record<string, L10n> = {
  en: { en: 'English', zh: '英文' },
  zh: { en: 'Chinese', zh: '中文' },
  fr: { en: 'French', zh: '法文' },
  ja: { en: 'Japanese', zh: '日文' },
  de: { en: 'German', zh: '德文' },
  ko: { en: 'Korean', zh: '韩文' },
  es: { en: 'Spanish', zh: '西班牙文' },
};

export const languageName = (code: string, lang: Lang): string => LANGUAGE_NAMES[code]?.[lang] ?? code;

export const KIND_NAMES: Record<SourceKind, L10n> = {
  official: { en: 'Official', zh: '官方' },
  reported: { en: 'Reported', zh: '媒体报道' },
  rumor: { en: 'Rumor', zh: '传闻' },
};

/** "Official: Qilin Lab blog" — the colon is full-width in Chinese. */
export const sep = (lang: Lang): string => (lang === 'zh' ? '：' : ': ');

type Copy = {
  coverageLabel: string;
  todayIn: (n: number) => string;
  why: string;
  next: string;
  seeSources: string;
  hideSources: string;
  open: string;
  paywall: string;
  ask: string;
  askOwn: string;
  askAbout: string;
  matches: string;
  translatedFrom: (language: string) => string;
  status: Record<AnswerStatus, string>;
  answerFoot: string;
  report: string;
  reported: string;
  reportPlaceholder: string;
  reportSend: string;
  cancel: string;
  shareStory: string;
  corrected: string;
  correctedNote: (date: string) => string;
  withdrawn: string;
  withdrawnTitle: string;
  survey: string;
  surveyAnswers: Record<'very' | 'somewhat' | 'not', string>;
  surveyThanks: string;
  inBrief: string;
  rumorTag: string;
  doneTitle: string;
  doneSub: string;
  useful: string;
  yes: string;
  no: string;
  thanks: string;
  subLabel: string;
  subButton: string;
  subFine: string;
  subDone: string;
  subConfirmed: string;
  subAgain: string;
  subFailed: string;
  subCheck: string;
  privacy: string;
  confirmWorking: string;
  confirmedTitle: string;
  confirmedText: string;
  linkFailedTitle: string;
  confirmFailedText: string;
  signInWorking: string;
  signedInTitle: string;
  signedInText: string;
  signInFailedText: string;
  unsubTitle: string;
  unsubText: string;
  unsubButton: string;
  unsubDoneTitle: string;
  unsubDoneText: string;
  unsubFailedText: string;
  unsubErase: string;
  unsubEraseNote: string;
  erasedTitle: string;
  erasedText: string;
  share: string;
  shared: string;
  previous: string;
  footer: string;
  how: string;
  corrections: string;
  archive: string;
  today: string;
  sample: string;
  sheetTitle: string;
  sheetNote: (n: number) => string;
  close: string;
  gateText: string;
  gateButton: string;
  gateFine: string;
  askPlaceholder: string;
  askButton: string;
  quota: (n: number) => string;
  quotaDaily: string;
  answering: string;
  answeringHint: string;
  answeringSlow: string;
  askTry: string;
  askNeedKey: string;
  signOut: string;
  askLimit: string;
  askPaused: string;
  askFailed: string;
  dek: (weekday: string, stories: number, minutes: number) => string;
  emptyTitle: string;
  emptyText: string;
  notFoundTitle: string;
  notFoundText: string;
  loadFailed: string;
  retry: string;
  archiveTitle: string;
  issueNumber: (n: number) => string;
  aboutTitle: string;
  about: { heading: string; body: string[] }[];
  correctionsTitle: string;
  correctionsIntro: string;
  correctionsEmpty: string;
  readStory: string;
  readIssue: string;
  draftBanner: string;
  languageLabel: string;
};

export const COPY: Record<Lang, Copy> = {
  en: {
    coverageLabel: 'Where today’s stories come from',
    todayIn: (n) => `Today in ${n}`,
    why: 'Why it matters',
    next: 'What to watch',
    seeSources: 'See sources',
    hideSources: 'Hide sources',
    open: 'Open',
    paywall: 'paywall',
    ask: 'Ask',
    askOwn: 'Ask your own question',
    askAbout: 'Questions about this story',
    matches: 'Matches the source',
    translatedFrom: (l) => `Translated from ${l}`,
    status: { answered: 'Answered from the sources', partial: 'Partly covered by the sources', none: 'Not covered by the sources' },
    answerFoot: 'AI answer, checked against this story’s sources.',
    report: 'Report a problem',
    reported: 'Thanks. A person will check this against the sources.',
    reportPlaceholder: 'What’s wrong? (optional)',
    reportSend: 'Send report',
    cancel: 'Cancel',
    shareStory: 'Share',
    corrected: 'Corrected',
    correctedNote: (date) => `Corrected ${date}`,
    withdrawn: 'Withdrawn',
    withdrawnTitle: 'Withdrawn from this issue',
    survey: 'How would you feel if you could no longer read AI in 5?',
    surveyAnswers: { very: 'Very disappointed', somewhat: 'Somewhat disappointed', not: 'Not disappointed' },
    surveyThanks: 'Thank you. That helps us decide what to build.',
    inBrief: 'In brief',
    rumorTag: 'Rumor, unconfirmed',
    doneTitle: 'You’re caught up.',
    doneSub: 'The next issue arrives tomorrow at 7:00, your local time.',
    useful: 'Was this issue useful?',
    yes: 'Useful',
    no: 'Not really',
    thanks: 'Thanks. This helps choose tomorrow’s stories.',
    subLabel: 'Get it in your inbox every morning',
    subButton: 'Subscribe',
    subFine: 'One email a day. Unsubscribe in one click.',
    subDone: 'Almost done: check your inbox and open the link in our email on this device.',
    subConfirmed: 'You’re subscribed. The next issue arrives at 7:00, your local time.',
    subAgain: 'Didn’t get our email, or on a new device? Enter your address again.',
    subFailed: 'That didn’t work. Check the address and try again.',
    subCheck: 'We couldn’t confirm you’re not a bot. Wait a moment and try again.',
    privacy: 'Privacy',
    confirmWorking: 'Confirming your subscription…',
    confirmedTitle: 'You’re subscribed',
    confirmedText: 'The next issue arrives at 7:00, your local time. Every email has a one-click unsubscribe link.',
    linkFailedTitle: 'This link didn’t work',
    confirmFailedText: 'It may have expired. Subscribe again and we’ll send a fresh link.',
    signInWorking: 'Signing you in…',
    signedInTitle: 'You can ask on this device',
    signedInText: 'Open any story and tap “Ask your own question”. This device stays signed in until you sign out.',
    signInFailedText: 'Sign-in links work for 30 minutes. Enter your address under any story and we’ll send a new one.',
    unsubTitle: 'Unsubscribe from AI in 5?',
    unsubText: 'You won’t get the daily email any more. The site stays open to read.',
    unsubButton: 'Unsubscribe',
    unsubDoneTitle: 'You’re unsubscribed',
    unsubDoneText: 'You won’t hear from us again. If you change your mind, subscribe on any issue.',
    unsubFailedText: 'Reply to any of our emails and we’ll take you off the list by hand.',
    unsubErase: 'Unsubscribe and delete my data',
    unsubEraseNote: 'Deleting also removes your questions and our record of which issues you opened. It can’t be undone.',
    erasedTitle: 'Your data is deleted',
    erasedText: 'Your address and everything linked to it are gone. You won’t hear from us again.',
    share: 'Share this issue',
    shared: 'Link copied',
    previous: 'Read the previous issue',
    footer: 'Written by AI. Every number and quote is checked against its source.',
    how: 'How it’s made',
    corrections: 'Corrections',
    archive: 'Archive',
    today: 'Today’s issue',
    sample: 'Sample issue. All companies and stories are fictional.',
    sheetTitle: 'Ask about this story',
    sheetNote: (n) => `Answers come only from this story’s ${n} ${n === 1 ? 'source' : 'sources'}.`,
    close: 'Close',
    gateText: 'Asking your own questions is free for subscribers. You’ll also get each issue at 7:00, your local time.',
    gateButton: 'Subscribe',
    gateFine: 'Already subscribed? Enter the same address and we’ll email you a link to ask on this device.',
    askPlaceholder: 'Ask about this story',
    askButton: 'Ask',
    quota: (n) => `${n} ${n === 1 ? 'question' : 'questions'} left today`,
    quotaDaily: 'Up to 10 questions a day. Answers come only from the sources.',
    answering: 'Reading the sources…',
    answeringHint: 'Usually 10 to 30 seconds.',
    answeringSlow: 'Taking longer than usual. It can take a few minutes, so leave this open.',
    askTry: 'Or start with one of these:',
    askNeedKey: 'This device isn’t signed in any more. Enter your address and we’ll email you a new link.',
    signOut: 'Sign out on this device',
    askLimit: 'You’ve asked your 10 questions for today. More tomorrow.',
    askPaused: 'Asking is paused right now. Try again later.',
    askFailed: 'Something went wrong. Try again.',
    dek: (weekday, stories, minutes) => `${weekday}’s issue: ${stories} ${stories === 1 ? 'story' : 'stories'}, about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`,
    emptyTitle: 'The first issue is on its way.',
    emptyText: 'Every morning at 7, the AI news that matters, from the US, China and beyond, in about five minutes.',
    notFoundTitle: 'There’s no issue here.',
    notFoundText: 'The link may be mistyped, or that issue was never published.',
    loadFailed: 'The issue didn’t load.',
    retry: 'Try again',
    archiveTitle: 'Archive',
    issueNumber: (n) => `Issue ${n}`,
    aboutTitle: 'How it’s made',
    about: [
      {
        heading: 'Written by AI, checked against the source',
        body: [
          'AI in 5 is written by AI. Every morning it reads official announcements, research papers and leading outlets from the US, China and Europe, picks the stories that matter and writes them in plain language.',
          'No person reviews each issue before it goes out. Instead, every story passes three checks before it is published, and anything that fails is cut. A shorter issue beats a wrong one. A person reads every problem report and spot-checks issues every week.',
        ],
      },
      {
        heading: 'The three checks',
        body: [
          'First, code, not AI, matches every number, date and quote against the original source.',
          'Second, a separate AI compares each claim with the source and removes anything overstated or unsupported.',
          'Third, the Chinese edition is checked so that numbers, names and links match the English one.',
          'A highlighted number is one that passed the first check. Tap it to see the original wording.',
        ],
      },
      {
        heading: 'Sources',
        body: [
          'Official means the company, lab or agency said it. Reported means a news outlet said it. Rumor means it is unconfirmed, and it only ever appears in the brief items.',
          'We link to the original, never to a copy. Images are published by the companies themselves, or are charts drawn from checked numbers. We never use AI-generated images.',
        ],
      },
      {
        heading: 'Answers to your questions',
        body: ['Answers come only from the story’s own sources, and every sentence is cited. If the sources don’t cover a question, the answer says so.'],
      },
      {
        heading: 'Corrections',
        body: [
          'When something is wrong, we fix the story and mark it “Corrected”, with what changed. A story that can’t be fixed is withdrawn. Both are listed on the corrections page, and the next email tells subscribers about them.',
        ],
      },
      {
        heading: 'Who makes it',
        body: ['AI in 5 is published by NetMind.AI Ltd, the company behind Manyfold, which runs the AI agents that write, review and answer. Write to customer-support@netmind.ai.'],
      },
    ],
    correctionsTitle: 'Corrections',
    correctionsIntro: 'When a story is wrong we fix it, mark it on the story and list it here. A story that can’t be fixed is withdrawn from its issue.',
    correctionsEmpty: 'No corrections so far.',
    readStory: 'Read the story',
    readIssue: 'Read the issue',
    draftBanner: 'Draft preview. Readers can’t see this issue until it is published in /admin.',
    languageLabel: 'Language',
  },
  zh: {
    coverageLabel: '今天的新闻来自哪里',
    todayIn: (n) => `今日${['一', '两', '三'][n - 1] ?? n}件事`,
    why: '为什么重要',
    next: '接下来关注',
    seeSources: '查看来源',
    hideSources: '收起来源',
    open: '打开',
    paywall: '付费墙',
    ask: '追问',
    askOwn: '自己提问',
    askAbout: '关于这条新闻的问题',
    matches: '与原文一致',
    translatedFrom: (l) => `译自${l}`,
    status: { answered: '来源中有答案', partial: '来源只提到一部分', none: '来源中没有提到' },
    answerFoot: 'AI 回答，已与本条来源核对。',
    report: '报错',
    reported: '收到，会有人对照来源核对。',
    reportPlaceholder: '哪里有问题？（选填）',
    reportSend: '提交',
    cancel: '取消',
    shareStory: '分享',
    corrected: '已更正',
    correctedNote: (date) => `${date}更正`,
    withdrawn: '已撤下',
    withdrawnTitle: '本期撤下的内容',
    survey: '如果以后再也看不到 AI in 5，你会有什么感觉？',
    surveyAnswers: { very: '非常失望', somewhat: '有点失望', not: '不会失望' },
    surveyThanks: '谢谢，这能帮我们决定接下来做什么。',
    inBrief: '快讯',
    rumorTag: '传闻，未证实',
    doneTitle: '今天的 AI，你已经跟上了。',
    doneSub: '下一期会在明天早上 7 点（你的当地时间）送到。',
    useful: '这期有用吗？',
    yes: '有用',
    no: '一般',
    thanks: '收到，这会帮助我们挑选明天的新闻。',
    subLabel: '每天早上送到你的邮箱',
    subButton: '订阅',
    subFine: '每天只有 1 封，随时一键退订。',
    subDone: '还差一步：去邮箱查收，并在这台设备上打开邮件里的链接。',
    subConfirmed: '你已订阅。下一期会在你当地时间早上 7 点送到。',
    subAgain: '没收到邮件，或者换了设备？再输入一次邮箱。',
    subFailed: '没有成功，请检查邮箱地址后重试。',
    subCheck: '没能确认你不是机器人，请稍等片刻再试。',
    privacy: '隐私政策',
    confirmWorking: '正在确认订阅…',
    confirmedTitle: '订阅成功',
    confirmedText: '下一期会在你当地时间早上 7 点送到。每封邮件底部都能一键退订。',
    linkFailedTitle: '这个链接无效',
    confirmFailedText: '链接可能已经过期。重新订阅一次，我们会再发一封确认邮件。',
    signInWorking: '正在登录…',
    signedInTitle: '这台设备可以提问了',
    signedInText: '打开任意一条新闻，点“自己提问”就行。退出之前，这台设备会一直保持登录。',
    signInFailedText: '登录链接 30 分钟内有效。在任意一条新闻下输入邮箱，我们会再发一个。',
    unsubTitle: '退订 AI in 5？',
    unsubText: '退订后不再收到每日邮件，网站照常可以看。',
    unsubButton: '确认退订',
    unsubDoneTitle: '已退订',
    unsubDoneText: '我们不会再给你发邮件。想回来的话，在任何一期页面上重新订阅就行。',
    unsubFailedText: '回复我们任意一封邮件，我们会手动帮你退订。',
    unsubErase: '退订并删除我的数据',
    unsubEraseNote: '删除后，你提过的问题和我们记录的阅读情况也会一并删除，无法恢复。',
    erasedTitle: '你的数据已删除',
    erasedText: '你的邮箱地址以及与之相关的所有记录都已删除。我们不会再给你发邮件。',
    share: '分享这期',
    shared: '链接已复制',
    previous: '看上一期',
    footer: '由 AI 撰写。每个数字和引语都已与原始来源核对。',
    how: '生产方法',
    corrections: '更正记录',
    archive: '往期',
    today: '今日简报',
    sample: '示例内容，公司和新闻均为虚构。',
    sheetTitle: '就这条新闻提问',
    sheetNote: (n) => `回答只依据本条的 ${n} 个来源。`,
    close: '关闭',
    gateText: '订阅后即可免费自己提问。每天早上 7 点（当地时间），你还会收到当天的简报。',
    gateButton: '订阅',
    gateFine: '已经订阅了？输入同一个邮箱，我们会发一个链接，让你在这台设备上提问。',
    askPlaceholder: '输入关于这条新闻的问题',
    askButton: '提问',
    quota: (n) => `今天还可以问 ${n} 次`,
    quotaDaily: '每天最多 10 个问题，回答只依据来源。',
    answering: '正在根据来源作答…',
    answeringHint: '通常需要 10–30 秒。',
    answeringSlow: '这次比平时慢，可能需要几分钟，请别关闭这个窗口。',
    askTry: '也可以先看看这些问题：',
    askNeedKey: '这台设备的登录已失效。输入邮箱，我们会给你发一个新链接。',
    signOut: '在这台设备上退出',
    askLimit: '今天的 10 次提问已用完，明天再来。',
    askPaused: '提问暂时关闭，请稍后再试。',
    askFailed: '出了点问题，请再试一次。',
    dek: (weekday, stories, minutes) => `${weekday}，${stories} 条新闻，约 ${minutes} 分钟`,
    emptyTitle: '第一期正在路上。',
    emptyText: '每天早上 7 点，5 分钟读懂全球 AI，美国和中国都不漏。',
    notFoundTitle: '这里没有简报。',
    notFoundText: '链接可能有误，或者这一期从未发布。',
    loadFailed: '简报没有加载出来。',
    retry: '重试',
    archiveTitle: '往期',
    issueNumber: (n) => `第 ${n} 期`,
    aboutTitle: '生产方法',
    about: [
      {
        heading: '由 AI 撰写，并与原始来源核对',
        body: [
          'AI in 5 由 AI 撰写。每天早上，它阅读美国、中国和欧洲的官方公告、研究论文和一线媒体报道，挑出真正重要的新闻，用大白话写出来。',
          '每一期发出前都没有人工逐条审稿。取而代之的是，每条新闻发布前都要通过三道审核，任何一道不通过就删掉。宁可这一期少一条，也不发错的。读者的每一条报错都会有人看，每周也会有人抽查。',
        ],
      },
      {
        heading: '三道审核',
        body: [
          '第一道：由程序（而不是 AI）把每个数字、日期和引语与原文逐一比对。',
          '第二道：另一个独立的 AI 对照原文检查每个说法，删掉夸大或没有依据的内容。',
          '第三道：核对中文版，保证数字、名称和链接与英文版完全一致。',
          '页面上被荧光笔划出的数字，就是通过了第一道审核的数字。点一下就能看到原文。',
        ],
      },
      {
        heading: '来源',
        body: [
          '"官方"表示这是公司、实验室或机构自己说的；"媒体报道"表示这是新闻媒体说的；"传闻"表示尚未证实，只会出现在快讯里。',
          '我们只链接原始出处，不链接转载。图片要么是公司自己发布的，要么是用核对过的数字画的图表。我们不使用 AI 生成的图片。',
        ],
      },
      {
        heading: '追问的回答',
        body: ['回答只依据这条新闻自己的来源，每句话都附出处。来源里没有提到的，回答会直接说明。'],
      },
      {
        heading: '更正记录',
        body: ['发现错误时，我们会修改原条目并标注"已更正"，写明改了什么；无法修正的会整条撤下。两种情况都会列在更正记录页，并在下一封邮件里告诉订阅者。'],
      },
      {
        heading: '谁在做',
        body: ['AI in 5 由 NetMind.AI Ltd 出品，也就是 Manyfold 背后的公司；撰写、审核和回答问题的 AI 智能体都运行在 Manyfold 上。联系我们：customer-support@netmind.ai。'],
      },
    ],
    correctionsTitle: '更正记录',
    correctionsIntro: '新闻出错时，我们会修改原条目、在条目上标注，并列在这里。无法修正的会从那一期撤下。',
    correctionsEmpty: '目前还没有更正。',
    readStory: '查看这条新闻',
    readIssue: '查看这一期',
    draftBanner: '草稿预览。在 /admin 发布之前，读者看不到这一期。',
    languageLabel: '语言',
  },
};

/** Issue dates are calendar days, so format them in UTC to avoid shifting a day. */
export function dateParts(date: string, lang: Lang): { label: string; weekday: string } {
  const d = new Date(`${date}T00:00:00Z`);
  if (lang === 'zh') {
    return {
      label: `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`,
      weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'UTC' }).format(d),
    };
  }
  return {
    label: new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d),
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(d),
  };
}

export function sourceTime(iso: string, lang: Lang): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (lang === 'zh') return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${hh}:${mm} UTC`;
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d);
  return `${month} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

/** The reader's own calendar date, used to pick "today's" issue. */
export function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
