/**
 * The issue as an email, following the email view in docs/design/app.html: masthead,
 * "Today in 3", each story with its checked numbers highlighted, "why it matters",
 * sources and links back to the web, then the briefs. One column, inline styles and
 * tables only, a plain-text twin, and well under Gmail's ~100 KB clipping limit.
 *
 * Issue text is escaped everywhere; marks and citations are tokens, never HTML. Each
 * recipient's unsubscribe link and ask key replace the UNSUBSCRIBE and ASK_KEY
 * placeholders after rendering: opening any story from the email lets that browser ask.
 */

import { readingMinutes, tokenize, type Issue, type L10n, type Lang, type RegionKey, type Story } from '../../shared/issue';

export const UNSUBSCRIBE = '%%UNSUBSCRIBE_URL%%';
export const ASK_KEY = '%%ASK_KEY%%';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const C = { paper: '#FFFFFF', ink: '#000000', graphite: '#5F5E58', hairline: '#E6E4DE', marker: '#FFE45C', stone: '#F2F1ED', green: '#0A5A39' };
const SERIF = "Georgia, 'Times New Roman', 'Noto Serif SC', 'Songti SC', serif";
const SANS = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

const REGION: Record<RegionKey, L10n> = {
  us: { en: 'US', zh: '美国' },
  cn: { en: 'China', zh: '中国' },
  eu: { en: 'Europe', zh: '欧洲' },
  jp: { en: 'Japan', zh: '日本' },
  other: { en: 'Elsewhere', zh: '其他地区' },
};

const T = {
  en: {
    todayIn: (n: number) => `Today in ${n}`,
    why: 'Why it matters',
    next: 'What to watch',
    inBrief: 'In brief',
    rumor: 'Rumor, unconfirmed',
    sources: 'Sources',
    ask: 'Ask about this story',
    web: 'Read on the web',
    footer: 'Written by AI. Every number and quote is checked against its source.',
    how: 'How it’s made',
    why_you: 'You’re getting this because you subscribed to AI in 5.',
    unsubscribe: 'Unsubscribe',
    other: 'Read in Chinese',
    dek: (weekday: string, items: number, minutes: number) => `${weekday}’s issue: ${items} ${items === 1 ? 'story' : 'stories'}, about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`,
  },
  zh: {
    todayIn: (n: number) => `今日${['一', '两', '三'][n - 1] ?? n}件事`,
    why: '为什么重要',
    next: '接下来关注',
    inBrief: '快讯',
    rumor: '传闻，未证实',
    sources: '来源',
    ask: '就这条新闻提问',
    web: '在网页上阅读',
    footer: '由 AI 撰写。每个数字和引语都已与原始来源核对。',
    how: '生产方法',
    why_you: '你收到这封邮件，是因为你订阅了 AI in 5。',
    unsubscribe: '退订',
    other: 'Read in English',
    dek: (weekday: string, items: number, minutes: number) => `${weekday}，${items} 条新闻，约 ${minutes} 分钟`,
  },
} as const;

export const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Links from issue data must be https; anything else becomes plain text. */
const safeUrl = (url: string): string | null => (/^https:\/\/[^\s"<>]+$/.test(url) ? url : null);
/** Links to our own site come from SITE_URL or the request origin, so local http is fine. */
const ownUrl = (url: string): string | null => (/^https?:\/\/[^\s"<>]+$/.test(url) ? url : null);

function dateLine(date: string, lang: Lang): { label: string; weekday: string; short: string } {
  const d = new Date(`${date}T00:00:00Z`);
  if (lang === 'zh') {
    return {
      label: `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`,
      weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'UTC' }).format(d),
      short: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`,
    };
  }
  return {
    label: new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d),
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(d),
    short: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d),
  };
}

/** Rich text to HTML: checked numbers get the highlighter, citation markers are dropped. */
function richHtml(value: string): string {
  return tokenize(value)
    .map((t) => (t.type === 'text' ? esc(t.text) : t.type === 'mark' ? `<span style="background:${C.marker};color:${C.ink};padding:0 2px;">${esc(t.text)}</span>` : ''))
    .join('');
}

const richText = (value: string): string =>
  tokenize(value)
    .map((t) => (t.type === 'cite' ? '' : t.text))
    .join('');

const p = (style: string, html: string) => `<p style="margin:0;${style}">${html}</p>`;
const anchor = (url: string | null, label: string, style: string) => (url ? `<a href="${esc(url)}" style="${style}">${esc(label)}</a>` : esc(label));
/** A link to a source: https only. */
const link = (url: string, label: string, style = `color:${C.ink};`) => anchor(safeUrl(url), label, style);
/** A link to our own site, or the unsubscribe placeholder. */
const siteLink = (url: string, label: string, style = `color:${C.ink};`) => anchor(url === UNSUBSCRIBE ? url : ownUrl(url), label, style);

function visualHtml(story: Story, lang: Lang): string {
  const v = story.visual;
  if (!v) return '';
  if (v.type === 'image') {
    const src = safeUrl(v.src);
    if (!src) return '';
    return `<img src="${esc(src)}" alt="${esc(v.alt[lang])}" width="556" style="display:block;width:100%;max-width:556px;height:auto;border:0;border-radius:4px;margin:16px 0 6px;">${p(`font:12px/1.4 ${SANS};color:${C.graphite};`, esc(v.credit[lang]))}`;
  }
  // Charts become a small table: readable without images and in every client.
  const rows = v.rows
    .map(
      (r) =>
        `<tr><td style="padding:6px 8px 6px 0;border-top:1px solid ${C.hairline};font:14px/1.4 ${SANS};color:${C.ink};">${esc(r.label[lang])}</td><td align="right" style="padding:6px 0;border-top:1px solid ${C.hairline};font:600 14px/1.4 ${SANS};color:${C.ink};white-space:nowrap;">${esc(r.shown[lang])}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 4px;"><tr><td colspan="2" style="padding:0 0 6px;font:600 14px/1.4 ${SANS};color:${C.ink};">${esc(v.title[lang])}</td></tr>${rows}</table>${p(`font:12px/1.4 ${SANS};color:${C.graphite};`, esc((v.type === 'compare' && v.note ? `${v.note[lang]} · ` : '') + v.credit[lang]))}`;
}

export function renderIssueEmail(issue: Issue, lang: Lang, site: string, postalAddress?: string): RenderedEmail {
  const t = T[lang];
  const other: Lang = lang === 'en' ? 'zh' : 'en';
  const base = site.replace(/\/+$/, '');
  const issueUrl = `${base}/${lang}/${issue.date}`;
  const storyUrl = (i: number) => `${issueUrl}/${i + 1}?k=${ASK_KEY}`;
  const d = dateLine(issue.date, lang);
  const dek = t.dek(d.weekday, issue.stories.length + issue.briefs.length, readingMinutes(issue, lang));
  const indexOf = new Map(issue.stories.map((s, i) => [s.id, i]));
  const lead = issue.today[0] ? richText(issue.today[0].text[lang]) : issue.stories[0] ? richText(issue.stories[0].title[lang]) : issue.briefs[0] ? richText(issue.briefs[0].text[lang]) : '';
  const subject = `${d.short} · ${lead}`.slice(0, 140);
  const preheader = issue.today.slice(1).map((x) => richText(x.text[lang])).join(' · ');

  const today = issue.today
    .map((x) => {
      const i = indexOf.get(x.id);
      const label = richText(x.text[lang]);
      return `<tr><td style="padding:10px 0;border-top:1px solid ${C.ink};font:17px/1.4 ${SERIF};color:${C.ink};">${i === undefined ? esc(label) : siteLink(storyUrl(i), label, `color:${C.ink};text-decoration:none;`)}</td></tr>`;
    })
    .join('');

  const stories = issue.stories
    .map((s, i) => {
      const meta = `<span style="color:${C.ink};font-weight:600;">${esc(REGION[s.region][lang])}</span>&nbsp;&nbsp;${esc(s.cat[lang])}`;
      const sources = s.sources.map((src) => link(src.url, src.name[lang], `color:${C.graphite};`)).join(lang === 'zh' ? '、' : ', ');
      return `<tr><td style="padding:${i === 0 ? 26 : 30}px 0 4px;border-top:${i === 0 ? 0 : 1}px solid ${C.hairline};">
${p(`font:14px/1.3 ${SANS};color:${C.graphite};`, meta)}
<h2 style="margin:8px 0 10px;font:${s.top ? '600 28px/1.15' : '600 22px/1.25'} ${SERIF};color:${C.ink};">${siteLink(storyUrl(i), s.title[lang], `color:${C.ink};text-decoration:none;`)}</h2>
${p(`font:17px/1.55 ${SERIF};color:${C.ink};`, richHtml(s.summary[lang]))}
${visualHtml(s, lang)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr><td style="background:${C.stone};border-radius:4px;padding:14px 16px 16px;">
${p(`font:600 14px/1.3 ${SANS};color:${C.ink};margin-bottom:6px;`, esc(t.why))}
${p(`font:16px/1.5 ${SERIF};color:${C.ink};`, richHtml(s.why[lang]))}
</td></tr></table>
${s.next ? `${p(`font:600 14px/1.3 ${SANS};color:${C.ink};margin-top:14px;margin-bottom:4px;`, esc(t.next))}${p(`font:16px/1.5 ${SERIF};color:${C.ink};`, richHtml(s.next[lang]))}` : ''}
${p(`font:14px/1.45 ${SANS};color:${C.graphite};margin-top:14px;`, `${esc(s.sourceLine[lang])} · ${esc(t.sources)}${lang === 'zh' ? '：' : ': '}${sources}`)}
${p(`font:600 15px/1.4 ${SANS};margin-top:14px;`, `${siteLink(`${storyUrl(i)}#ask`, t.ask, `color:${C.green};`)}&nbsp;&nbsp;&nbsp;${siteLink(storyUrl(i), t.web, `color:${C.ink};font-weight:500;`)}`)}
</td></tr>`;
    })
    .join('');

  const briefs = issue.briefs
    .map(
      (b) => `<tr><td style="padding:12px 0;border-top:1px solid ${C.hairline};">
${p(`font:13px/1.3 ${SANS};color:${C.graphite};margin-bottom:4px;`, `<span style="color:${C.ink};font-weight:600;">${esc(REGION[b.region][lang])}</span>${b.kind === 'rumor' ? `&nbsp;&nbsp;${esc(t.rumor)}` : ''}&nbsp;&nbsp;${esc(b.src[lang])}`)}
${p(`font:16px/1.5 ${SERIF};color:${C.ink};`, richHtml(b.text[lang]))}
</td></tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.stone};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.stone};"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.paper};"><tr><td style="padding:24px 22px 30px;">
${p(`font:700 20px/1 ${SERIF};color:${C.ink};letter-spacing:-0.01em;`, siteLink(`${base}/${lang}/`, 'AI in 5', `color:${C.ink};text-decoration:none;`))}
<h1 style="margin:14px 0 6px;font:600 ${lang === 'zh' ? '34px/1.2' : '40px/1.05'} ${SERIF};color:${C.ink};">${esc(d.label)}</h1>
${p(`font:15px/1.4 ${SANS};color:${C.graphite};margin-bottom:22px;`, esc(dek))}
${today ? `${p(`font:600 14px/1.3 ${SANS};color:${C.ink};margin-bottom:6px;`, esc(t.todayIn(issue.today.length)))}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${today}</table>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">${stories}</table>
${briefs ? `<h2 style="margin:30px 0 4px;font:600 22px/1.25 ${SERIF};color:${C.ink};">${esc(t.inBrief)}</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${briefs}</table>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;"><tr><td style="padding-top:20px;border-top:1px solid ${C.hairline};font:12.5px/1.6 ${SANS};color:${C.graphite};">
${p('', `${esc(t.footer)} ${siteLink(`${base}/${lang}/about`, t.how)}`)}
${p('margin-top:8px;', `${esc(t.why_you)} ${siteLink(UNSUBSCRIBE, t.unsubscribe)} · ${siteLink(`${base}/${other}/${issue.date}`, t.other)}`)}
${postalAddress ? p('margin-top:8px;', esc(postalAddress)) : ''}
</td></tr></table>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const lines: string[] = [`AI in 5 · ${d.label}`, dek];
  if (issue.today.length) lines.push('', t.todayIn(issue.today.length).toUpperCase());
  issue.today.forEach((x, n) => lines.push(`${n + 1}. ${richText(x.text[lang])}`));
  issue.stories.forEach((s, i) => {
    lines.push('', '—', `${REGION[s.region][lang]} · ${s.cat[lang]}`, richText(s.title[lang]).toUpperCase(), '', richText(s.summary[lang]), '', `${t.why}: ${richText(s.why[lang])}`);
    if (s.next) lines.push(`${t.next}: ${richText(s.next[lang])}`);
    lines.push(`${s.sourceLine[lang]}. ${t.sources}: ${s.sources.map((src) => `${src.name[lang]} ${src.url}`).join(' · ')}`, `${t.ask}: ${storyUrl(i)}#ask`);
  });
  if (issue.briefs.length) {
    lines.push('', '—', t.inBrief.toUpperCase());
    issue.briefs.forEach((b) => lines.push(`· ${REGION[b.region][lang]}${b.kind === 'rumor' ? ` (${t.rumor})` : ''}: ${richText(b.text[lang])}`));
  }
  lines.push('', '—', t.footer, `${t.web}: ${issueUrl}`, `${t.why_you} ${t.unsubscribe}: ${UNSUBSCRIBE}`);
  if (postalAddress) lines.push(postalAddress);

  return { subject, html, text: lines.join('\n') };
}

/** A short email with one button: the confirmation and the sign-in link share this layout. */
function renderButtonEmail(lang: Lang, url: string, copy: { subject: string; intro: string; button: string; ignore: string }): RenderedEmail {
  const { subject, intro, button, ignore } = copy;
  const safe = ownUrl(url) ?? '';
  const html = `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.stone};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.stone};"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${C.paper};"><tr><td style="padding:28px 24px 30px;">
${p(`font:700 20px/1 ${SERIF};color:${C.ink};`, 'AI in 5')}
${p(`font:17px/1.55 ${SERIF};color:${C.ink};margin-top:18px;`, esc(intro))}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="background:${C.ink};border-radius:4px;"><a href="${esc(safe)}" style="display:inline-block;padding:12px 20px;font:600 16px/1 ${SANS};color:${C.paper};text-decoration:none;">${esc(button)}</a></td></tr></table>
${p(`font:13px/1.5 ${SANS};color:${C.graphite};`, esc(ignore))}
</td></tr></table>
</td></tr></table>
</body></html>`;
  const text = `AI in 5\n\n${intro}\n\n${button}: ${safe}\n\n${ignore}`;
  return { subject, html, text };
}

export function renderConfirmEmail(lang: Lang, confirmUrl: string): RenderedEmail {
  const zh = lang === 'zh';
  return renderButtonEmail(lang, confirmUrl, {
    subject: zh ? '请确认订阅 AI in 5' : 'Confirm your AI in 5 subscription',
    intro: zh
      ? '只差一步：点下面的按钮确认邮箱，之后每天早上 7 点（你的当地时间），你会收到当天的 AI in 5。'
      : 'One step left: confirm your address and you’ll get AI in 5 every morning at 7:00, your local time.',
    button: zh ? '确认订阅' : 'Confirm my subscription',
    ignore: zh ? '如果不是你本人订阅的，忽略这封邮件即可，我们不会再给你发邮件。' : 'If you didn’t ask for this, ignore this email and you won’t hear from us again.',
  });
}

/** For a confirmed subscriber asking from a device that has no ask key yet. */
export function renderSignInEmail(lang: Lang, signInUrl: string, minutes: number): RenderedEmail {
  const zh = lang === 'zh';
  return renderButtonEmail(lang, signInUrl, {
    subject: zh ? '在这台设备上提问：AI in 5 登录链接' : 'Your AI in 5 sign-in link',
    intro: zh
      ? `在你想提问的那台设备上点下面的按钮，之后就能在那里就新闻自己提问了。链接 ${minutes} 分钟内有效，不会改动你的订阅。`
      : `Tap the button on the device where you want to ask your own questions about the news. The link works for ${minutes} minutes and doesn’t change your subscription.`,
    button: zh ? '在这台设备上提问' : 'Ask on this device',
    ignore: zh ? '如果不是你本人申请的，忽略这封邮件即可。没有这个链接，别人无法用你的身份提问。' : 'If you didn’t ask for this, ignore this email. Without this link, nobody can ask in your name.',
  });
}
