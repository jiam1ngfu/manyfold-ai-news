/**
 * The daily issue: its shape (shared by the Worker API and the reader app) and the
 * pure helpers both sides need — rich-text tokenizing, reading time, and validation of
 * an issue before it is stored. No runtime imports from either side.
 *
 * Rich text inside story fields uses two tiny markers instead of HTML, so nothing from
 * the database is ever injected as markup:
 *   <m0>one-eighth</m0>  a number checked against the story's marks[0] (the highlighter)
 *   [1]                  a citation, numbered within its answer
 */

export type Lang = 'en' | 'zh';
export const LANGS: readonly Lang[] = ['en', 'zh'];

/** One string per language. */
export type L10n = Record<Lang, string>;

export type RegionKey = 'us' | 'cn' | 'eu' | 'jp' | 'other';
export type SourceKind = 'official' | 'reported' | 'rumor';
export type AnswerStatus = 'answered' | 'partial' | 'none';

export interface Source {
  kind: SourceKind;
  name: L10n;
  /** Language of the original, e.g. "en", "zh", "fr", "ja". */
  lang: string;
  /** ISO 8601, UTC. */
  time: string;
  url: string;
  paywall?: boolean;
}

/** A verbatim quote from one of the story's sources, with optional translations. */
export interface Quote {
  src: number;
  quote: string;
  tr?: Partial<L10n>;
}

export interface AskPreset {
  status: AnswerStatus;
  cites: Quote[];
  q: L10n;
  /** Answer text; may contain [n] citation markers. */
  a: L10n;
}

export interface Org {
  name: string;
  /** https URL or data:image URL; rendered with <img>, never inlined. */
  logo: string;
}

export interface Place {
  lon: number;
  lat: number;
}

export interface ChartRow {
  label: L10n;
  value: number;
  shown: L10n;
  /** Index into the story's marks: the value is a checked number. */
  mark?: number;
  focus?: boolean;
}

export type Visual =
  | { type: 'compare'; title: L10n; note?: L10n; rows: ChartRow[]; credit: L10n }
  | { type: 'change'; title: L10n; axis: { en: [string, string]; zh: [string, string] }; rows: ChartRow[]; credit: L10n }
  | { type: 'image'; src: string; alt: L10n; credit: L10n };

export interface Story {
  id: string;
  region: RegionKey;
  top?: boolean;
  org?: Org;
  place: Place;
  cat: L10n;
  title: L10n;
  /** May contain <mN>…</mN> markers. */
  summary: L10n;
  why: L10n;
  next?: L10n;
  sourceLine: L10n;
  sources: Source[];
  marks: Quote[];
  visual?: Visual;
  ask: AskPreset[];
}

export interface Brief {
  region: RegionKey;
  kind: SourceKind;
  org?: Org;
  place: Place;
  src: L10n;
  text: L10n;
}

/**
 * A change the owner made after publishing. A corrected story stays, marked, with its
 * fixed text; a withdrawn story or brief is taken out and only this notice remains.
 */
export interface Correction {
  /** ISO 8601, UTC. */
  at: string;
  kind: 'corrected' | 'withdrawn';
  /** The story's id; absent for a withdrawn brief. */
  story?: string;
  /** A withdrawn story's 1-based position as published, so later stories keep theirs (storySlots). */
  slot?: number;
  /** The headline readers now see; for a withdrawn item, its last headline (or brief text), so it can still be named. */
  title: L10n;
  /** What was wrong and what changed. */
  note: L10n;
}

export interface Issue {
  /** YYYY-MM-DD: the morning the issue is delivered. */
  date: string;
  number: number;
  /** "Today in 3": each line points at a story id. */
  today: { id: string; text: L10n }[];
  stories: Story[];
  briefs: Brief[];
  /** Changes made after publishing, oldest first. */
  corrections?: Correction[];
  /** True for the fictional sample used in local development. */
  sample?: boolean;
}

/** One entry in the public corrections log. */
export interface CorrectionEntry extends Correction {
  date: string;
  number: number;
  /** 1-based position of a corrected story in its issue, for the link; null when withdrawn. */
  position: number | null;
}

export interface IssueResponse {
  issue: Issue | null;
  prev: string | null;
  next: string | null;
}

export interface IssueSummary {
  date: string;
  number: number;
  headline: L10n;
}

/* ───────── rich text ───────── */

export type TextToken =
  | { type: 'text'; text: string }
  | { type: 'mark'; index: number; text: string }
  | { type: 'cite'; n: number };

/** Splits text into plain runs, checked-number marks and citation markers. */
export function tokenize(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  const pattern = /<m(\d+)>(.*?)<\/m\1>|\[(\d+)\]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) tokens.push({ type: 'text', text: text.slice(last, at) });
    if (match[1] !== undefined) tokens.push({ type: 'mark', index: Number(match[1]), text: match[2] });
    else tokens.push({ type: 'cite', n: Number(match[3]) });
    last = at + match[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) });
  return tokens;
}

/** Text with the markers removed, for counting and for plain contexts. */
export const plainText = (text: string): string =>
  tokenize(text)
    .map((t) => (t.type === 'cite' ? '' : t.text))
    .join('');

/* ───────── reading time ───────── */

const WORDS_PER_MINUTE = 240;
const HAN_PER_MINUTE = 350;

function readingUnits(text: string, lang: Lang): number {
  const plain = plainText(text);
  if (lang === 'zh') {
    const han = plain.match(/\p{Script=Han}/gu)?.length ?? 0;
    const latinWords = plain.replace(/\p{Script=Han}/gu, ' ').match(/[A-Za-z0-9]+/g)?.length ?? 0;
    return han / HAN_PER_MINUTE + latinWords / WORDS_PER_MINUTE;
  }
  return (plain.match(/\S+/g)?.length ?? 0) / WORDS_PER_MINUTE;
}

/** Whole minutes to read the issue (never less than 1). */
export function readingMinutes(issue: Issue, lang: Lang): number {
  const parts: string[] = [];
  issue.today.forEach((t) => parts.push(t.text[lang]));
  issue.stories.forEach((s) => parts.push(s.title[lang], s.summary[lang], s.why[lang], s.next?.[lang] ?? ''));
  issue.briefs.forEach((b) => parts.push(b.text[lang]));
  const minutes = parts.reduce((sum, p) => sum + readingUnits(p, lang), 0);
  return Math.max(1, Math.round(minutes));
}

/* ───────── validation ───────── */

export class IssueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueValidationError';
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REGIONS: readonly RegionKey[] = ['us', 'cn', 'eu', 'jp', 'other'];
const KINDS: readonly SourceKind[] = ['official', 'reported', 'rumor'];
const STATUSES: readonly AnswerStatus[] = ['answered', 'partial', 'none'];

type Json = Record<string, unknown>;

function fail(path: string, problem: string): never {
  throw new IssueValidationError(`${path}: ${problem}`);
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, path: string, max = 2000): string {
  if (typeof v !== 'string' || v.trim() === '') fail(path, 'must be a non-empty string');
  if (v.length > max) fail(path, `must be at most ${max} characters`);
  return v;
}

function l10n(v: unknown, path: string, max = 2000): L10n {
  if (!isObject(v)) fail(path, 'must be an object with en and zh');
  return { en: str(v.en, `${path}.en`, max), zh: str(v.zh, `${path}.zh`, max) };
}

function partialL10n(v: unknown, path: string): Partial<L10n> | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) fail(path, 'must be an object');
  const out: Partial<L10n> = {};
  if (v.en !== undefined) out.en = str(v.en, `${path}.en`);
  if (v.zh !== undefined) out.zh = str(v.zh, `${path}.zh`);
  return out;
}

function arr(v: unknown, path: string, max = 50): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be an array');
  if (v.length > max) fail(path, `must have at most ${max} entries`);
  return v;
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a number');
  return v;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], path: string): T {
  if (typeof v !== 'string' || !options.includes(v as T)) fail(path, `must be one of ${options.join(', ')}`);
  return v as T;
}

/** Images and logos are shown with <img>: only https and data:image URLs are allowed. */
function imageUrl(v: unknown, path: string): string {
  const s = str(v, path, 200_000);
  if (!/^https:\/\//.test(s) && !/^data:image\/(svg\+xml|png|jpeg|webp)[;,]/.test(s)) {
    fail(path, 'must be an https URL or a data:image URL');
  }
  return s;
}

function linkUrl(v: unknown, path: string): string {
  const s = str(v, path);
  if (!/^https?:\/\//.test(s)) fail(path, 'must be an http(s) URL');
  return s;
}

function quote(v: unknown, path: string, sources: number): Quote {
  if (!isObject(v)) fail(path, 'must be an object');
  const src = num(v.src, `${path}.src`);
  if (!Number.isInteger(src) || src < 0 || src >= sources) fail(`${path}.src`, 'must point at one of the story sources');
  return { src, quote: str(v.quote, `${path}.quote`), tr: partialL10n(v.tr, `${path}.tr`) };
}

function markRefs(text: L10n, path: string, marks: number): void {
  for (const lang of LANGS) {
    for (const t of tokenize(text[lang])) {
      if (t.type === 'mark' && t.index >= marks) fail(`${path}.${lang}`, `uses <m${t.index}> but the story has ${marks} marks`);
    }
  }
}

function citeRefs(text: L10n, path: string, cites: number): void {
  for (const lang of LANGS) {
    for (const t of tokenize(text[lang])) {
      if (t.type === 'cite' && (t.n < 1 || t.n > cites)) fail(`${path}.${lang}`, `cites [${t.n}] but the answer has ${cites} citations`);
    }
  }
}

function org(v: unknown, path: string): Org | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) fail(path, 'must be an object');
  return { name: str(v.name, `${path}.name`, 120), logo: imageUrl(v.logo, `${path}.logo`) };
}

function place(v: unknown, path: string): Place {
  if (!isObject(v)) fail(path, 'must be an object');
  const lon = num(v.lon, `${path}.lon`);
  const lat = num(v.lat, `${path}.lat`);
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) fail(path, 'must be a valid longitude and latitude');
  return { lon, lat };
}

function chartRows(v: unknown, path: string, marks: number): ChartRow[] {
  return arr(v, path, 6).map((r, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(r)) fail(p, 'must be an object');
    const mark = r.mark === undefined ? undefined : num(r.mark, `${p}.mark`);
    if (mark !== undefined && (mark < 0 || mark >= marks)) fail(`${p}.mark`, 'must point at one of the story marks');
    return { label: l10n(r.label, `${p}.label`, 80), value: num(r.value, `${p}.value`), shown: l10n(r.shown, `${p}.shown`, 30), mark, focus: r.focus === true || undefined };
  });
}

function visual(v: unknown, path: string, marks: number): Visual | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) fail(path, 'must be an object');
  const type = oneOf(v.type, ['compare', 'change', 'image'] as const, `${path}.type`);
  if (type === 'image') {
    return { type, src: imageUrl(v.src, `${path}.src`), alt: l10n(v.alt, `${path}.alt`, 300), credit: l10n(v.credit, `${path}.credit`, 200) };
  }
  const rows = chartRows(v.rows, `${path}.rows`, marks);
  if (rows.length < 2 && type === 'compare') fail(`${path}.rows`, 'a comparison needs at least two rows');
  const title = l10n(v.title, `${path}.title`, 120);
  const credit = l10n(v.credit, `${path}.credit`, 200);
  if (type === 'compare') {
    if (rows.some((r) => r.value < 0)) fail(`${path}.rows`, 'comparison values must not be negative');
    return { type, title, note: v.note === undefined ? undefined : l10n(v.note, `${path}.note`, 160), rows, credit };
  }
  if (!isObject(v.axis)) fail(`${path}.axis`, 'must be an object');
  const axis = { en: arr(v.axis.en, `${path}.axis.en`, 2), zh: arr(v.axis.zh, `${path}.axis.zh`, 2) };
  if (axis.en.length !== 2 || axis.zh.length !== 2) fail(`${path}.axis`, 'needs two labels per language');
  return {
    type,
    title,
    axis: {
      en: [str(axis.en[0], `${path}.axis.en[0]`, 30), str(axis.en[1], `${path}.axis.en[1]`, 30)],
      zh: [str(axis.zh[0], `${path}.axis.zh[0]`, 30), str(axis.zh[1], `${path}.axis.zh[1]`, 30)],
    },
    rows,
    credit,
  };
}

function story(v: unknown, path: string): Story {
  if (!isObject(v)) fail(path, 'must be an object');
  const id = str(v.id, `${path}.id`, 60);
  if (!/^[a-z0-9-]+$/.test(id)) fail(`${path}.id`, 'must use lowercase letters, digits and dashes');
  const sources = arr(v.sources, `${path}.sources`, 10).map((s, i) => {
    const p = `${path}.sources[${i}]`;
    if (!isObject(s)) fail(p, 'must be an object');
    const time = str(s.time, `${p}.time`, 40);
    if (Number.isNaN(Date.parse(time))) fail(`${p}.time`, 'must be an ISO date-time');
    return {
      kind: oneOf(s.kind, KINDS, `${p}.kind`),
      name: l10n(s.name, `${p}.name`, 120),
      lang: str(s.lang, `${p}.lang`, 10),
      time,
      url: linkUrl(s.url, `${p}.url`),
      paywall: s.paywall === true || undefined,
    };
  });
  if (sources.length === 0) fail(`${path}.sources`, 'every story needs at least one source');
  const marks = arr(v.marks, `${path}.marks`, 10).map((m, i) => quote(m, `${path}.marks[${i}]`, sources.length));
  const summary = l10n(v.summary, `${path}.summary`);
  markRefs(summary, `${path}.summary`, marks.length);
  const ask = arr(v.ask, `${path}.ask`, 4).map((a, i) => {
    const p = `${path}.ask[${i}]`;
    if (!isObject(a)) fail(p, 'must be an object');
    const cites = arr(a.cites, `${p}.cites`, 6).map((c, j) => quote(c, `${p}.cites[${j}]`, sources.length));
    const answer = l10n(a.a, `${p}.a`);
    citeRefs(answer, `${p}.a`, cites.length);
    return { status: oneOf(a.status, STATUSES, `${p}.status`), cites, q: l10n(a.q, `${p}.q`, 200), a: answer };
  });
  return {
    id,
    region: oneOf(v.region, REGIONS, `${path}.region`),
    top: v.top === true || undefined,
    org: org(v.org, `${path}.org`),
    place: place(v.place, `${path}.place`),
    cat: l10n(v.cat, `${path}.cat`, 40),
    title: l10n(v.title, `${path}.title`, 200),
    summary,
    why: l10n(v.why, `${path}.why`),
    next: v.next === undefined ? undefined : l10n(v.next, `${path}.next`),
    sourceLine: l10n(v.sourceLine, `${path}.sourceLine`, 120),
    sources,
    marks,
    visual: visual(v.visual, `${path}.visual`, marks.length),
    ask,
  };
}

export const MAX_BRIEFS = 6;

/** Checks an issue from an untrusted source (the admin API, later the pipeline). */
export function validateIssue(raw: unknown): Issue {
  if (!isObject(raw)) fail('issue', 'must be an object');
  const date = str(raw.date, 'date', 10);
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) fail('date', 'must be YYYY-MM-DD');
  const number = num(raw.number, 'number');
  if (!Number.isInteger(number) || number < 1) fail('number', 'must be a positive integer');
  const stories = arr(raw.stories, 'stories', 10).map((s, i) => story(s, `stories[${i}]`));
  const ids = new Set(stories.map((s) => s.id));
  if (ids.size !== stories.length) fail('stories', 'story ids must be unique');
  const today = arr(raw.today, 'today', 3).map((t, i) => {
    if (!isObject(t)) fail(`today[${i}]`, 'must be an object');
    const id = str(t.id, `today[${i}].id`, 60);
    if (!ids.has(id)) fail(`today[${i}].id`, 'must point at a story in this issue');
    return { id, text: l10n(t.text, `today[${i}].text`, 300) };
  });
  const briefs = arr(raw.briefs, 'briefs', MAX_BRIEFS).map((b, i) => {
    const p = `briefs[${i}]`;
    if (!isObject(b)) fail(p, 'must be an object');
    const kind = oneOf(b.kind, KINDS, `${p}.kind`);
    const brief: Brief = {
      region: oneOf(b.region, REGIONS, `${p}.region`),
      kind,
      org: org(b.org, `${p}.org`),
      place: place(b.place, `${p}.place`),
      src: l10n(b.src, `${p}.src`, 160),
      text: l10n(b.text, `${p}.text`, 400),
    };
    // A rumor never carries a company logo: it would read as an official statement.
    if (kind === 'rumor' && brief.org) fail(`${p}.org`, 'rumors must not carry a logo');
    return brief;
  });
  // A thin day may have no full story, only briefs; an issue with nothing in it is not one.
  if (stories.length + briefs.length === 0) fail('stories', 'an issue needs at least one story or brief');
  const corrections =
    raw.corrections === undefined
      ? undefined
      : arr(raw.corrections, 'corrections', 30).map((c, i) => {
          const p = `corrections[${i}]`;
          if (!isObject(c)) fail(p, 'must be an object');
          const at = str(c.at, `${p}.at`, 40);
          if (Number.isNaN(Date.parse(at))) fail(`${p}.at`, 'must be an ISO date-time');
          const kind = oneOf(c.kind, ['corrected', 'withdrawn'] as const, `${p}.kind`);
          const storyId = c.story === undefined ? undefined : str(c.story, `${p}.story`, 60);
          // A corrected story may have been withdrawn later, so only its id is required here.
          if (kind === 'corrected' && !storyId) fail(`${p}.story`, 'a correction must name its story');
          const slot = c.slot === undefined ? undefined : num(c.slot, `${p}.slot`);
          if (slot !== undefined && (!Number.isInteger(slot) || slot < 1 || slot > 20)) fail(`${p}.slot`, 'must be a position from 1 to 20');
          return { at, kind, story: storyId, slot, title: l10n(c.title, `${p}.title`, 400), note: l10n(c.note, `${p}.note`, 600) };
        });
  return { date, number, today, stories, briefs, corrections, sample: raw.sample === true || undefined };
}

/* ───────── corrections ───────── */

/** One position in an issue as published: its story, or the notice of a story withdrawn from it. */
export type Slot = { story: Story } | { withdrawn: Correction };

/**
 * The issue's stories in their published positions. Links to a story (/en/DATE/N in
 * emails, share cards and the reader) use these positions, so withdrawing a story leaves
 * a notice in its place instead of renumbering the stories after it.
 */
export function storySlots(issue: Issue): Slot[] {
  const slots: Slot[] = issue.stories.map((story) => ({ story }));
  const gone = (issue.corrections ?? []).filter((c) => c.kind === 'withdrawn' && c.slot !== undefined).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  for (const c of gone) slots.splice(Math.min((c.slot ?? 1) - 1, slots.length), 0, { withdrawn: c });
  return slots;
}

/** A story's 1-based published position, or 0 when it is not in the issue. */
export const storyPosition = (issue: Issue, storyId: string): number => storySlots(issue).findIndex((s) => 'story' in s && s.story.id === storyId) + 1;

/** What is at a published position: a story, a withdrawn story's notice, or nothing. */
export const storyAt = (issue: Issue, position: number): Slot | null => (position >= 1 ? (storySlots(issue)[position - 1] ?? null) : null);

export type StoryFix = Partial<Record<'title' | 'summary' | 'why' | 'next', L10n>>;

export interface CorrectionRequest {
  kind: 'corrected' | 'withdrawn';
  /** A story id, or "brief-N" (0-based) for a brief. */
  target: string;
  note: L10n;
  /** Only for kind "corrected": the story's fields as they should now read. */
  fix?: StoryFix;
}

/**
 * The owner's correction applied to a published issue: a corrected story keeps its place
 * with the fixed text, a withdrawn story or brief is removed (and its "Today in 3" line
 * with it). Returns a new issue, validated like any other.
 */
export function applyCorrection(issue: Issue, request: CorrectionRequest, at: string): Issue {
  const next: Issue = structuredClone(issue);
  const note = l10n(request.note, 'note', 600);
  const brief = /^brief-(\d+)$/.exec(request.target);
  if (brief) {
    if (request.kind !== 'withdrawn') fail('kind', 'a brief can only be withdrawn');
    const index = Number(brief[1]);
    const removed = next.briefs[index];
    if (!removed) fail('target', 'no such brief in this issue');
    next.briefs.splice(index, 1);
    next.corrections = [...(next.corrections ?? []), { at, kind: 'withdrawn', title: removed.text, note }];
  } else {
    const index = next.stories.findIndex((s) => s.id === request.target);
    if (index < 0) fail('target', 'no such story in this issue');
    const story = next.stories[index];
    if (request.kind === 'withdrawn') {
      const slot = storyPosition(issue, story.id);
      next.stories.splice(index, 1);
      next.today = next.today.filter((t) => t.id !== story.id);
      next.corrections = [...(next.corrections ?? []), { at, kind: 'withdrawn', story: story.id, slot, title: story.title, note }];
    } else {
      const fix = request.fix ?? {};
      for (const field of ['title', 'summary', 'why', 'next'] as const) {
        if (fix[field] !== undefined) story[field] = l10n(fix[field], `fix.${field}`);
      }
      next.corrections = [...(next.corrections ?? []), { at, kind: 'corrected', story: story.id, title: story.title, note }];
    }
  }
  if (next.stories.length + next.briefs.length === 0) fail('target', 'this is the last item: unpublish the issue instead');
  return validateIssue(next);
}
