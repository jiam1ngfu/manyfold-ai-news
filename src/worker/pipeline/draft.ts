/**
 * The writer agent's English draft: the shape we ask for, and a forgiving reader that
 * coerces whatever came back into it. Nothing here decides truth; checks.ts does.
 */

import { jsonrepair } from 'jsonrepair';
import type { AnswerStatus, RegionKey, SourceKind } from '../../shared/issue';

export interface DraftSource {
  url: string;
  name: string;
  kind: SourceKind;
  lang: string;
  published: string | null;
}

export interface DraftQuote {
  source: number;
  quote: string;
  /** English translation, when the source is not in English. */
  translation?: string;
}

export interface DraftQuestion {
  q: string;
  status: AnswerStatus;
  a: string;
  cites: DraftQuote[];
}

export interface DraftChartRow {
  label: string;
  value: number;
  shown: string;
  mark?: number;
  focus?: boolean;
}

export interface DraftChart {
  type: 'compare' | 'change';
  title: string;
  note?: string;
  axis?: [string, string];
  rows: DraftChartRow[];
}

export interface DraftStory {
  id: string;
  region: RegionKey;
  top: boolean;
  org: string | null;
  lon: number | null;
  lat: number | null;
  category: string;
  title: string;
  summary: string;
  why: string;
  next: string | null;
  sources: DraftSource[];
  marks: DraftQuote[];
  chart: DraftChart | null;
  image: { source: number; alt: string } | null;
  questions: DraftQuestion[];
}

export interface DraftBrief {
  region: RegionKey;
  org: string | null;
  lon: number | null;
  lat: number | null;
  kind: SourceKind;
  text: string;
  sourceName: string;
  url: string;
}

export interface Draft {
  today: { story: string; text: string }[];
  stories: DraftStory[];
  briefs: DraftBrief[];
}

export const CATEGORIES = ['Models', 'Products', 'Companies', 'Funding', 'Research', 'Open Source', 'Policy', 'Hardware'] as const;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optText = (v: unknown): string | null => text(v) || null;
const int = (v: unknown, fallback = -1): number => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : fallback);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (typeof v === 'string' && options.includes(v as T) ? (v as T) : fallback);

const REGIONS: readonly RegionKey[] = ['us', 'cn', 'eu', 'jp', 'other'];
const KINDS: readonly SourceKind[] = ['official', 'reported', 'rumor'];
const STATUSES: readonly AnswerStatus[] = ['answered', 'partial', 'none'];

function quote(v: unknown): DraftQuote {
  const q = obj(v);
  const translation = optText(q.translation);
  return { source: int(q.source), quote: text(q.quote), ...(translation ? { translation } : {}) };
}

function slug(value: string, index: number): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || `story-${index + 1}`;
}

/**
 * Repairs the two marker typos models make, a closing tag missing its ">" or its "/":
 * "<m0>$250 million</m0 in damages" would otherwise leave a stray "0" that check 1
 * rejects. Only the tag syntax changes; the words and numbers stay as written.
 */
export function repairMarkers(value: string): string {
  return value.replace(/<\/m(\d+)(?![\d>])/g, '</m$1>').replace(/<m(\d+)>([^<]*?)<m\1>/g, '<m$1>$2</m$1>');
}

/**
 * Strips a ```json fence or surrounding prose and parses the first JSON object. A model
 * typo (a stray quote, a trailing comma) is repaired rather than losing a billed turn;
 * whatever comes out still goes through every check, so a bad repair can only cut.
 */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The agent did not return a JSON object.');
  const json = body.slice(start, end + 1);
  try {
    return JSON.parse(json);
  } catch (error) {
    try {
      return JSON.parse(jsonrepair(json));
    } catch {
      throw error;
    }
  }
}

export function readDraft(raw: unknown): Draft {
  const root = obj(raw);
  const usedIds = new Set<string>();
  const stories = list(root.stories).map((v, i): DraftStory => {
    const s = obj(v);
    let id = slug(text(s.id) || text(s.title), i);
    while (usedIds.has(id)) id = `${id}-${i + 1}`;
    usedIds.add(id);
    const chart = obj(s.chart);
    const image = obj(s.image);
    const axis = list(chart.axis).map(text);
    return {
      id,
      region: pick(s.region, REGIONS, 'other'),
      top: s.top === true,
      org: optText(s.org),
      lon: num(s.lon),
      lat: num(s.lat),
      category: pick(s.category, CATEGORIES, 'Companies'),
      title: text(s.title),
      summary: repairMarkers(text(s.summary)),
      why: text(s.why),
      next: optText(s.next),
      sources: list(s.sources).map((src) => {
        const o = obj(src);
        return { url: text(o.url), name: text(o.name), kind: pick(o.kind, KINDS, 'reported'), lang: text(o.lang) || 'en', published: optText(o.published) };
      }),
      marks: list(s.marks).map(quote),
      chart:
        chart.type === 'compare' || chart.type === 'change'
          ? {
              type: chart.type,
              title: text(chart.title),
              note: optText(chart.note) ?? undefined,
              axis: axis.length === 2 ? [axis[0], axis[1]] : undefined,
              rows: list(chart.rows).map((r) => {
                const row = obj(r);
                const mark = int(row.mark);
                return { label: text(row.label), value: num(row.value) ?? NaN, shown: text(row.shown), ...(mark >= 0 ? { mark } : {}), ...(row.focus === true ? { focus: true } : {}) };
              }),
            }
          : null,
      image: Object.keys(image).length ? { source: int(image.source), alt: text(image.alt) } : null,
      questions: list(s.questions).map((v2) => {
        const q = obj(v2);
        return { q: text(q.q), status: pick(q.status, STATUSES, 'none'), a: text(q.a), cites: list(q.cites).map(quote) };
      }),
    };
  });
  const briefs = list(root.briefs).map((v): DraftBrief => {
    const b = obj(v);
    return {
      region: pick(b.region, REGIONS, 'other'),
      org: optText(b.org),
      lon: num(b.lon),
      lat: num(b.lat),
      kind: pick(b.kind, KINDS, 'reported'),
      text: text(b.text),
      sourceName: text(b.sourceName),
      url: text(b.url),
    };
  });
  const today = list(root.today).map((v) => {
    const t = obj(v);
    return { story: text(t.story), text: text(t.text) };
  });
  if (stories.length === 0) throw new Error('The draft has no stories.');
  return { today, stories, briefs };
}
