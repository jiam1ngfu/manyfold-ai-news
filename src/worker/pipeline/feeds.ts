/**
 * Where candidate stories come from: a fixed list of feeds (each checked by hand), parsed
 * with small tolerant parsers. Most are RSS/Atom; a few official newsrooms publish no feed,
 * so their listing page is read instead ("newsroom": each article link with a date).
 * Agent-suggested sources are not collected here; whatever the agent cites is fetched and
 * checked later.
 */

import type { RegionKey, SourceKind } from '../../shared/issue';
import { fetchTimeout, safeErrorText } from '../a2a';

export interface FeedSource {
  id: string;
  name: { en: string; zh: string };
  url: string;
  kind: SourceKind;
  lang: 'en' | 'zh';
  region: RegionKey;
  /** For general tech feeds: keep only items whose title matches. */
  filter?: RegExp;
  /** A listing page instead of a feed: article links matching `links` under `base`. */
  newsroom?: { base: string; links: RegExp };
  /** false when the site's share images are only logos or stock illustrations. */
  images?: boolean;
}

const AI_EN = /\b(AI|A\.I\.|artificial intelligence|model|LLM|chip|GPU|agent|OpenAI|Anthropic|DeepSeek|Qwen|Gemini|Nvidia|robot)/i;
const AI_ZH = /AI|人工智能|大模型|模型|智能体|机器人|芯片|算力|GPU|OpenAI|DeepSeek|通义|千问|文心|混元|豆包|Kimi|智谱/;

export const FEEDS: FeedSource[] = [
  { id: 'openai', name: { en: 'OpenAI', zh: 'OpenAI' }, url: 'https://openai.com/news/rss.xml', kind: 'official', lang: 'en', region: 'us' },
  { id: 'deepmind', name: { en: 'Google DeepMind blog', zh: 'Google DeepMind 博客' }, url: 'https://deepmind.google/blog/rss.xml', kind: 'official', lang: 'en', region: 'eu' },
  { id: 'google-ai', name: { en: 'Google AI blog', zh: 'Google AI 博客' }, url: 'https://blog.google/technology/ai/rss/', kind: 'official', lang: 'en', region: 'us' },
  { id: 'google', name: { en: 'Google blog', zh: 'Google 官方博客' }, url: 'https://blog.google/rss/', kind: 'official', lang: 'en', region: 'us', filter: AI_EN },
  { id: 'anthropic', name: { en: 'Anthropic', zh: 'Anthropic' }, url: 'https://www.anthropic.com/news', kind: 'official', lang: 'en', region: 'us', images: false, newsroom: { base: 'https://www.anthropic.com', links: /^\/news\/[a-z0-9-]+$/ } },
  { id: 'meta-ai', name: { en: 'Meta AI blog', zh: 'Meta AI 博客' }, url: 'https://ai.meta.com/blog/', kind: 'official', lang: 'en', region: 'us', newsroom: { base: 'https://ai.meta.com', links: /^(https:\/\/ai\.meta\.com)?\/blog\/[a-z0-9-]+\/?$/ } },
  { id: 'mistral', name: { en: 'Mistral AI', zh: 'Mistral AI' }, url: 'https://mistral.ai/news/rss', kind: 'official', lang: 'en', region: 'eu' },
  { id: 'nvidia', name: { en: 'NVIDIA blog', zh: 'NVIDIA 博客' }, url: 'https://blogs.nvidia.com/feed/', kind: 'official', lang: 'en', region: 'us', filter: AI_EN },
  { id: 'huggingface', name: { en: 'Hugging Face blog', zh: 'Hugging Face 博客' }, url: 'https://huggingface.co/blog/feed.xml', kind: 'official', lang: 'en', region: 'us' },
  { id: 'techcrunch', name: { en: 'TechCrunch', zh: 'TechCrunch' }, url: 'https://techcrunch.com/category/artificial-intelligence/feed/', kind: 'reported', lang: 'en', region: 'us' },
  { id: 'verge', name: { en: 'The Verge', zh: 'The Verge' }, url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', kind: 'reported', lang: 'en', region: 'us' },
  { id: 'ars', name: { en: 'Ars Technica', zh: 'Ars Technica' }, url: 'https://arstechnica.com/ai/feed/', kind: 'reported', lang: 'en', region: 'us' },
  { id: 'mittr', name: { en: 'MIT Technology Review', zh: '麻省理工科技评论' }, url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', kind: 'reported', lang: 'en', region: 'us' },
  { id: 'scmp', name: { en: 'South China Morning Post', zh: '南华早报' }, url: 'https://www.scmp.com/rss/36/feed', kind: 'reported', lang: 'en', region: 'cn', filter: AI_EN },
  { id: 'qbitai', name: { en: 'QbitAI', zh: '量子位' }, url: 'https://www.qbitai.com/feed', kind: 'reported', lang: 'zh', region: 'cn' },
  { id: 'ithome', name: { en: 'IT Home', zh: 'IT之家' }, url: 'https://www.ithome.com/rss/', kind: 'reported', lang: 'zh', region: 'cn', filter: AI_ZH },
];

export interface FeedItem {
  title: string;
  link: string;
  published: string | null;
  summary: string;
}

export interface Candidate extends FeedItem {
  /** Short id the agent uses to refer to this candidate, e.g. "c7". */
  id: string;
  feed: string;
  sourceName: { en: string; zh: string };
  kind: SourceKind;
  lang: 'en' | 'zh';
  region: RegionKey;
  published: string;
}

/** Hosts whose share images are never news pictures (see FeedSource.images). */
export const NO_IMAGE_HOSTS = new Set(FEEDS.filter((f) => f.images === false).map((f) => new URL(f.url).hostname));

export const hostIs = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/**
 * News outlets. A page the picker adds from one of them is a report, never an official
 * source, so its pictures are never shown. The feeds' own outlets are included.
 */
const MEDIA_DOMAINS = [
  ...FEEDS.filter((f) => f.kind !== 'official').map((f) => new URL(f.url).hostname.replace(/^www\./, '')),
  'reuters.com', 'bloomberg.com', 'cnbc.com', 'ft.com', 'wsj.com', 'nytimes.com', 'washingtonpost.com', 'theinformation.com',
  'wired.com', 'venturebeat.com', 'axios.com', 'businessinsider.com', 'theguardian.com', 'bbc.com', 'bbc.co.uk', 'apnews.com',
  'forbes.com', 'fortune.com', 'zdnet.com', 'engadget.com', 'semafor.com', 'techmeme.com', 'theregister.com', 'tomshardware.com',
  'siliconangle.com', 'nikkei.com', 'medium.com', 'substack.com',
  '36kr.com', 'jiqizhixin.com', 'huxiu.com', 'sina.com.cn', 'sina.cn', 'yicai.com', 'caixin.com', 'thepaper.cn', 'jiemian.com',
  'ifeng.com', '163.com', 'sohu.com', 'news.qq.com', 'new.qq.com', 'cls.cn', 'stcn.com', 'leiphone.com', 'geekpark.net',
];

export function isMediaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return MEDIA_DOMAINS.some((d) => hostIs(host, d));
  } catch {
    return false;
  }
}

/* ───────── parsing ───────── */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const unwrap = (raw: string): string => raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');

/** Markup to plain text: drop tags, decode entities, collapse whitespace. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function tag(block: string, names: string[]): string | null {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    if (match) return unwrap(match[1]);
  }
  return null;
}

function linkOf(block: string): string | null {
  const atom = block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i) ?? block.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i);
  if (atom) return decodeEntities(atom[1]);
  const rss = tag(block, ['link']);
  return rss ? decodeEntities(rss.trim()) : null;
}

/** Parses RSS 2.0 <item>s and Atom <entry>s. Tolerant of CDATA and namespaces. */
export function parseFeed(xml: string): FeedItem[] {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = tag(block, ['title']);
    const link = linkOf(block);
    if (!title || !link || !/^https?:\/\//.test(link)) continue;
    const date = tag(block, ['pubDate', 'published', 'updated', 'dc:date']);
    const parsed = date ? Date.parse(decodeEntities(date.trim())) : NaN;
    const summary = tag(block, ['description', 'summary', 'content:encoded', 'content']) ?? '';
    items.push({
      title: stripTags(title).slice(0, 300),
      link,
      published: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
      summary: stripTags(summary).slice(0, 700),
    });
  }
  return items;
}

const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const LISTING_DATE = new RegExp(`\\b(?:${MONTHS})\\.? \\d{1,2}, \\d{4}\\b`);
const LABEL = /^(announcements?|featured|latest news|news|product|products|policy|research|open source|company|societal impacts|interpretability|alignment|case study|customer stories|read more|learn more)$/i;

/**
 * Reads a newsroom listing page: every link to an article whose card carries a date like
 * "Oct 8, 2026". The title is the first text in the card that is not the date or a label.
 */
export function parseNewsroom(html: string, base: string, links: RegExp): FeedItem[] {
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(match[1]);
    if (!links.test(href)) continue;
    const link = new URL(href, base).toString();
    if (seen.has(link)) continue;
    const parts = match[2]
      .split(/<[^>]+>/)
      .map((t) => decodeEntities(t).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const date = parts.map((p) => p.match(LISTING_DATE)?.[0]).find(Boolean);
    const text = parts.filter((p) => !LISTING_DATE.test(p) && !LABEL.test(p) && p.length > 3);
    if (!date || text.length === 0) continue;
    const parsed = Date.parse(`${date.replace('.', '')} 12:00 UTC`);
    if (Number.isNaN(parsed)) continue;
    seen.add(link);
    items.push({ title: text[0].slice(0, 300), link, published: new Date(parsed).toISOString(), summary: (text[1] ?? '').slice(0, 700) });
  }
  return items;
}

/* ───────── collecting ───────── */

export interface FeedResult {
  feed: string;
  items: number;
  error?: string;
}

const FEED_TIMEOUT_MS = 12_000;
const PER_FEED = 8;
const MAX_CANDIDATES = 70;

export async function collectCandidates(window: { from: Date; to: Date }): Promise<{ candidates: Candidate[]; feeds: FeedResult[] }> {
  const results = await Promise.all(
    FEEDS.map(async (feed): Promise<{ result: FeedResult; items: FeedItem[] }> => {
      try {
        const response = await fetchTimeout(
          feed.url,
          { headers: { 'user-agent': 'AIin5/1.0 (+daily AI briefing)', accept: 'application/rss+xml, application/atom+xml, text/xml, */*' } },
          FEED_TIMEOUT_MS,
        );
        if (!response.ok) return { result: { feed: feed.id, items: 0, error: `HTTP ${response.status}` }, items: [] };
        const body = await response.text();
        const items = (feed.newsroom ? parseNewsroom(body, feed.newsroom.base, feed.newsroom.links) : parseFeed(body))
          .filter((item) => item.published && Date.parse(item.published) >= window.from.getTime() && Date.parse(item.published) <= window.to.getTime())
          .filter((item) => !feed.filter || feed.filter.test(item.title))
          .slice(0, PER_FEED);
        return { result: { feed: feed.id, items: items.length }, items };
      } catch (error) {
        return { result: { feed: feed.id, items: 0, error: safeErrorText(error instanceof Error ? error.message : error) }, items: [] };
      }
    }),
  );

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  results.forEach(({ items }, i) => {
    const feed = FEEDS[i];
    for (const item of items) {
      const key = item.link.replace(/[?#].*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...item, published: item.published!, id: '', feed: feed.id, sourceName: feed.name, kind: feed.kind, lang: feed.lang, region: feed.region });
    }
  });
  candidates.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  return {
    candidates: candidates.slice(0, MAX_CANDIDATES).map((c, i) => ({ ...c, id: `c${i + 1}` })),
    feeds: results.map((r) => r.result),
  };
}
