/**
 * The reader's pages as the server sends them. The app renders in the browser, but link
 * previews (X, LinkedIn, Slack, WhatsApp, iMessage, Telegram) and search engines never
 * run it: they read the HTML. So every page is the app's index.html with that page's own
 * title, description, share card (Open Graph and X), canonical link and language
 * alternates, and the right status: 404 for an unknown path or an unpublished issue.
 * Also the sitemap.
 *
 * wrangler.jsonc sends page paths here first (assets.run_worker_first); static files
 * still come straight from the assets binding.
 */

import { plainText, storyAt, type Issue, type Lang } from '../shared/issue';
import { BASE_PATH } from '../shared/base';
import type { Env } from './types';
import { dateLine } from './email/render';
import { turnstileOn } from './turnstile';

export type PageRoute =
  | { name: 'root' }
  | { name: 'today'; lang: Lang }
  | { name: 'issue'; lang: Lang; date: string; story: number | null }
  | { name: 'archive' | 'about' | 'privacy' | 'corrections'; lang: Lang }
  | { name: 'confirm' | 'signin' | 'unsubscribe'; lang: Lang }
  | { name: 'admin' }
  | { name: 'notFound'; lang: Lang };

const STATIC = ['archive', 'about', 'privacy', 'corrections'] as const;
const LINKS = ['confirm', 'signin', 'unsubscribe'] as const;

/** Mirrors src/app/reader/router.ts parseRoute, without the browser's saved language. */
export function classify(path: string): PageRoute {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'root' };
  const [first, second, third] = parts;
  if (first === 'admin') return { name: 'admin' };
  if (first !== 'en' && first !== 'zh') return { name: 'notFound', lang: 'en' };
  const lang: Lang = first;
  if (!second) return { name: 'today', lang };
  if (!third && (STATIC as readonly string[]).includes(second)) return { name: second as (typeof STATIC)[number], lang };
  if (!third && (LINKS as readonly string[]).includes(second)) return { name: second as (typeof LINKS)[number], lang };
  if (/^\d{4}-\d{2}-\d{2}$/.test(second) && parts.length <= 3) {
    if (!third) return { name: 'issue', lang, date: second, story: null };
    if (/^\d{1,2}$/.test(third) && Number(third) > 0) return { name: 'issue', lang, date: second, story: Number(third) };
  }
  return { name: 'notFound', lang };
}

export interface PageMeta {
  status: number;
  lang: Lang;
  title: string;
  /** The share card's title, when it differs from the page title (a story's own headline). */
  shareTitle?: string;
  description: string;
  /** Path below the site, e.g. /en/2026-10-13. Null for pages that are not indexed. */
  path: string | null;
  /** The same page in the other language. */
  alternate: string | null;
  type: 'website' | 'article';
  noindex: boolean;
  published?: string;
}

const SITE_COPY = {
  en: {
    name: 'AI in 5',
    tagline: 'Daily AI news in five minutes',
    description: 'Every morning at 7, the AI news that matters, from the US, China and beyond, in about five minutes. Every number and quote is checked against its source.',
    archive: 'Archive',
    about: 'How it’s made',
    privacy: 'Privacy',
    corrections: 'Corrections',
    aboutText: 'Written by AI, checked against the source: how AI in 5 picks, writes and checks every story, and how it corrects mistakes.',
    privacyText: 'What AI in 5 keeps about subscribers, why, for how long, and how to have it deleted.',
    correctionsText: 'Every correction and withdrawn story in AI in 5, with what changed.',
    archiveText: 'Every issue of AI in 5, the daily AI briefing.',
    link: 'AI in 5',
    notFound: 'There’s no issue here',
  },
  zh: {
    name: 'AI in 5',
    tagline: '5 分钟读懂全球 AI',
    description: '每天早上 7 点，5 分钟读懂全球 AI，美国和中国都不漏。每个数字和引语都与原始来源核对。',
    archive: '往期',
    about: '生产方法',
    privacy: '隐私政策',
    corrections: '更正记录',
    aboutText: '由 AI 撰写，并与原始来源核对：AI in 5 如何挑选、撰写和核对每条新闻，以及如何更正错误。',
    privacyText: 'AI in 5 会保存订阅者的哪些信息、为什么、保存多久，以及如何删除。',
    correctionsText: 'AI in 5 的每一次更正和撤下的新闻，以及改了什么。',
    archiveText: 'AI in 5 每日 AI 简报的全部往期。',
    link: 'AI in 5',
    notFound: '这里没有简报',
  },
} as const;

/** Shortens at a word boundary when there is one near the end (English), else at the limit (Chinese). */
const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const word = cut.replace(/[\s,.;:]+\S*$/, '');
  return `${word.length > max * 0.7 ? word : cut}…`;
};

const other = (lang: Lang): Lang => (lang === 'en' ? 'zh' : 'en');

/** The tags for one page. `issue` is the published issue the route points at, if any. */
export function pageMeta(route: PageRoute, issue: Issue | null): PageMeta {
  const lang: Lang = 'lang' in route ? route.lang : 'en';
  const C = SITE_COPY[lang];
  const base = { lang, type: 'website' as const, noindex: false, status: 200 };
  const titled = (page: string) => `${page} · ${C.name}`;
  switch (route.name) {
    case 'root':
      return { ...base, title: `${C.name} · ${C.tagline}`, description: C.description, path: '/', alternate: null };
    case 'today':
      // Which issue is "today" depends on the reader's time zone, so the card describes the site.
      return { ...base, title: `${C.name} · ${C.tagline}`, description: C.description, path: `/${lang}/`, alternate: `/${other(lang)}/` };
    case 'issue': {
      // Positions are as published: a withdrawn story's link opens the issue at its notice.
      const slot = route.story && issue ? storyAt(issue, route.story) : null;
      if (!issue || (route.story && !slot)) return notFound(lang);
      const story = slot && 'story' in slot ? slot.story : null;
      const when = dateLine(issue.date, lang).label;
      if (story) {
        const suffix = `/${issue.date}/${route.story}`;
        return {
          ...base,
          type: 'article',
          title: `${story.title[lang]} · ${C.name}`,
          shareTitle: story.title[lang],
          description: clip(plainText(story.summary[lang]), 280),
          path: `/${lang}${suffix}`,
          alternate: `/${other(lang)}${suffix}`,
          published: issue.date,
        };
      }
      const lines = issue.today.length ? issue.today.map((t) => t.text[lang]) : issue.stories.map((s) => s.title[lang]);
      return {
        ...base,
        type: 'article',
        title: `${C.name} · ${when}`,
        description: clip(lines.join(' · ') || C.description, 280),
        path: `/${lang}/${issue.date}`,
        alternate: `/${other(lang)}/${issue.date}`,
        published: issue.date,
      };
    }
    case 'archive':
    case 'about':
    case 'privacy':
    case 'corrections': {
      const text = { archive: C.archiveText, about: C.aboutText, privacy: C.privacyText, corrections: C.correctionsText }[route.name];
      return { ...base, title: titled(C[route.name]), description: text, path: `/${lang}/${route.name}`, alternate: `/${other(lang)}/${route.name}` };
    }
    case 'confirm':
    case 'signin':
    case 'unsubscribe':
      return { ...base, title: C.name, description: C.description, path: null, alternate: null, noindex: true };
    case 'admin':
      return { ...base, title: `${C.name} admin`, description: '', path: null, alternate: null, noindex: true };
    case 'notFound':
      return notFound(lang);
  }
}

function notFound(lang: Lang): PageMeta {
  const C = SITE_COPY[lang];
  return { status: 404, lang, title: `${C.notFound} · ${C.name}`, description: C.description, path: null, alternate: null, type: 'website', noindex: true };
}

const attr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The <head> tags for a page. `site` is the public site, base path included. */
export function headTags(meta: PageMeta, site: string, extra: { turnstileSiteKey?: string } = {}): string {
  const image = `${site}/og/card-${meta.lang}.png`;
  const tags: string[] = [`<meta name="description" content="${attr(meta.description)}">`];
  if (meta.noindex) tags.push('<meta name="robots" content="noindex">');
  if (meta.path) {
    const url = `${site}${meta.path}`;
    tags.push(`<link rel="canonical" href="${attr(url)}">`);
    if (meta.alternate) {
      const [en, zh] = meta.lang === 'en' ? [meta.path, meta.alternate] : [meta.alternate, meta.path];
      tags.push(
        `<link rel="alternate" hreflang="en" href="${attr(site + en)}">`,
        `<link rel="alternate" hreflang="zh-Hans" href="${attr(site + zh)}">`,
        `<link rel="alternate" hreflang="x-default" href="${attr(site + en)}">`,
      );
    }
    tags.push(
      `<meta property="og:url" content="${attr(url)}">`,
      `<meta property="og:type" content="${meta.type}">`,
      `<meta property="og:site_name" content="AI in 5">`,
      `<meta property="og:title" content="${attr(meta.shareTitle ?? meta.title)}">`,
      `<meta property="og:description" content="${attr(meta.description)}">`,
      `<meta property="og:image" content="${attr(image)}">`,
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      `<meta property="og:image:alt" content="${attr(meta.lang === 'zh' ? 'AI in 5：5 分钟读懂全球 AI' : 'AI in 5: daily AI news in five minutes')}">`,
      `<meta property="og:locale" content="${meta.lang === 'zh' ? 'zh_CN' : 'en_US'}">`,
      `<meta property="og:locale:alternate" content="${meta.lang === 'zh' ? 'en_US' : 'zh_CN'}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:title" content="${attr(meta.shareTitle ?? meta.title)}">`,
      `<meta name="twitter:description" content="${attr(meta.description)}">`,
      `<meta name="twitter:image" content="${attr(image)}">`,
    );
    if (meta.published) tags.push(`<meta property="article:published_time" content="${meta.published}T00:00:00Z">`);
  }
  if (extra.turnstileSiteKey) tags.push(`<meta name="aiin5:turnstile" content="${attr(extra.turnstileSiteKey)}">`);
  return tags.join('\n    ');
}

/** The site's public address, base path included: SITE_URL, else this host. */
export const publicSite = (env: Env, requestUrl: string): string => ((env.SITE_URL ?? '').trim() || `${new URL(requestUrl).origin}${BASE_PATH}`).replace(/\/+$/, '');

async function publishedIssue(env: Env, date: string): Promise<Issue | null> {
  const row = await env.DB.prepare("SELECT data FROM issues WHERE status = 'published' AND date = ?").bind(date).first<{ data: string }>();
  return row ? (JSON.parse(row.data) as Issue) : null;
}

/** One reader page: index.html from the assets, with this page's tags and status. */
export async function renderPage(env: Env, request: Request, path: string): Promise<Response> {
  const route = classify(path);
  const issue = route.name === 'issue' ? await publishedIssue(env, route.date) : null;
  const meta = pageMeta(route, issue);
  const shell = await env.ASSETS.fetch(new Request(new URL('/', request.url), { headers: { accept: 'text/html' } }));
  const site = publicSite(env, request.url);
  const tags = headTags(meta, site, { turnstileSiteKey: turnstileOn(env) ? (env.TURNSTILE_SITE_KEY ?? '').trim() : undefined });
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
  // Revalidated every time: a cached page would name old hashed assets after a deploy.
  // Email-link pages and the console are never stored at all.
  headers.set('cache-control', meta.noindex && meta.status === 200 ? 'no-store' : 'no-cache');
  if (meta.noindex) headers.set('x-robots-tag', 'noindex');
  const response = new HTMLRewriter()
    .on('html', {
      element(el) {
        el.setAttribute('lang', meta.lang === 'zh' ? 'zh-Hans' : 'en');
      },
    })
    .on('title', {
      element(el) {
        el.setInnerContent(meta.title);
      },
    })
    .on('head', {
      element(el) {
        el.append(`    ${tags}\n  `, { html: true });
      },
    })
    .transform(new Response(shell.body, { status: meta.status, headers }));
  return response;
}

/** Every page worth indexing, both languages, newest issues first. */
export function sitemapXml(site: string, issues: { date: string; updatedAt: string }[]): string {
  const url = (path: string, alt: string, lastmod?: string) =>
    `  <url><loc>${attr(site + path)}</loc>${lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : ''}` +
    `<xhtml:link rel="alternate" hreflang="en" href="${attr(site + (path.startsWith('/en') ? path : alt))}"/>` +
    `<xhtml:link rel="alternate" hreflang="zh-Hans" href="${attr(site + (path.startsWith('/zh') ? path : alt))}"/></url>`;
  const pair = (suffix: string, lastmod?: string) => [url(`/en${suffix}`, `/zh${suffix}`, lastmod), url(`/zh${suffix}`, `/en${suffix}`, lastmod)];
  const lines = [
    ...pair('/', issues[0]?.updatedAt),
    ...issues.flatMap((i) => pair(`/${i.date}`, i.updatedAt)),
    ...pair('/archive', issues[0]?.updatedAt),
    ...pair('/about'),
    ...pair('/corrections'),
    ...pair('/privacy'),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${lines.join('\n')}\n</urlset>\n`;
}

export async function renderSitemap(env: Env, request: Request): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT date, updated_at FROM issues WHERE status = 'published' ORDER BY date DESC LIMIT 1000").all<{ date: string; updated_at: string }>();
  const xml = sitemapXml(publicSite(env, request.url), results.map((r) => ({ date: r.date, updatedAt: r.updated_at })));
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
