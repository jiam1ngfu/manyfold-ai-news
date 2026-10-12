/**
 * Check 1 of 3: deterministic, no AI. Every quote must appear in the cited source's
 * text, every number in the story must be found in its sources, and banned hype words
 * are refused. A story that fails is dropped; a highlight, question, chart or image that
 * fails is removed and the story is kept. Everything is recorded for the run report.
 */

import { plainText, tokenize } from '../../shared/issue';
import type { Draft, DraftBrief, DraftQuote, DraftStory } from './draft';

export interface SourceText {
  text: string;
  image?: string | null;
}

/** Folds the differences that should not count: case, width, quotes, dashes, spacing. */
export function canonical(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, '');
}

/** A quote may skip text with an ellipsis; each part must appear, in order. */
export function quoteFound(quote: string, source: string): boolean {
  const parts = quote
    .split(/…|\.\.\./)
    .map((p) => canonical(p).replace(/^["'\s]+|["'\s]+$/g, ''))
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  const haystack = canonical(source);
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/** Numbers as written, normalized: "1,200" → "1200", "3.5" stays, "70B" → "70". */
export function numbersIn(value: string): string[] {
  const found = plainText(value).normalize('NFKC').match(/\d+(?:[.,]\d+)*/g) ?? [];
  return found.map((n) => (/^\d{1,3}(,\d{3})+$/.test(n) ? n.replace(/,/g, '') : n.replace(/,/g, '.')));
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const MONTH_NUMBERS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const EN_SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, bn: 1e9, k: 1e3, m: 1e6, b: 1e9 };
const ZH_SCALE: Record<string, number> = { 千: 1e3, 万: 1e4, 百万: 1e6, 千万: 1e7, 亿: 1e8, 万亿: 1e12 };

/**
 * The values a text states, with units applied, so "$200 million" and "2 亿美元" compare
 * equal. English month names and small number words count too ("November 12" → 11, 12).
 */
export function quantities(value: string, lang: 'en' | 'zh'): number[] {
  let text = plainText(value).normalize('NFKC');
  if (lang === 'en') {
    text = text
      .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, (m) => ` ${MONTH_NUMBERS[m.toLowerCase()]} `)
      .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi, (m) => ` ${NUMBER_WORDS[m.toLowerCase()]} `);
  }
  const pattern = lang === 'en' ? /(\d+(?:[.,]\d+)*)\s*(thousand|million|billion|trillion|bn|[kmb])?\b/gi : /(\d+(?:[.,]\d+)*)\s*(万亿|千万|百万|千|万|亿)?/g;
  const out: number[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    const n = Number(/^\d{1,3}(,\d{3})+$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(/,/g, '.'));
    if (!Number.isFinite(n)) continue;
    const unit = match[2]?.toLowerCase();
    const scale = unit ? (lang === 'en' ? EN_SCALE[unit] : ZH_SCALE[unit]) ?? 1 : 1;
    out.push(n * scale);
  }
  return out;
}

const sameValue = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Values the Chinese states that the English does not. Empty means the numbers agree. */
export function extraQuantities(en: string, zh: string): number[] {
  const english = quantities(en, 'en');
  return [...new Set(quantities(zh, 'zh').filter((v) => !english.some((e) => sameValue(e, v))))];
}

export const BANNED = ['game-changer', 'game changer', 'revolutionary', 'shocking', 'insane', 'mind-blowing', 'breaking', 'groundbreaking', 'unprecedented', 'jaw-dropping'];

function bannedIn(value: string): string | null {
  const lower = value.toLowerCase();
  return BANNED.find((w) => new RegExp(`\\b${w.replace(/[-\s]/g, '[-\\s]')}\\b`).test(lower)) ?? null;
}

const words = (value: string): number => plainText(value).split(/\s+/).filter(Boolean).length;

export interface ItemCheck {
  id: string;
  title: string;
  kept: boolean;
  reasons: string[];
  warnings: string[];
}

function verified(q: DraftQuote, texts: (string | null)[]): boolean {
  const src = texts[q.source];
  return typeof src === 'string' && q.quote.length > 0 && quoteFound(q.quote, src);
}

/** Checks one story against the fetched source texts. Returns a cleaned copy. */
export function checkStory(story: DraftStory, sources: Map<string, SourceText>): { check: ItemCheck; story: DraftStory | null } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const check = (kept: boolean): ItemCheck => ({ id: story.id, title: story.title, kept, reasons, warnings });

  if (!story.title || !story.summary || !story.why) reasons.push('Missing title, summary or "why it matters".');
  if (story.sources.length === 0) reasons.push('No sources.');
  if (story.sources.length > 0 && story.sources.every((s) => s.kind === 'rumor')) reasons.push('Only rumors: it can be a brief at most.');

  const texts = story.sources.map((s) => sources.get(s.url)?.text ?? null);
  story.sources.forEach((s, i) => {
    if (texts[i] === null) warnings.push(`Source ${i + 1} (${s.url}) could not be read.`);
  });
  if (texts.every((t) => t === null)) reasons.push('None of the sources could be read.');

  // Marks: the highlighted, checked numbers.
  const markOk = story.marks.map((m) => verified(m, texts));
  markOk.forEach((ok, i) => {
    if (!ok) reasons.push(`Quote for mark ${i} is not in source ${story.marks[i].source + 1}.`);
  });

  // Numbers: every number must appear in a source, or in the translation of a quote
  // that was itself found in its source (sources in other languages write numbers differently).
  const allowed = new Set<string>();
  texts.forEach((t) => t && numbersIn(t).forEach((n) => allowed.add(n)));
  story.marks.forEach((m, i) => {
    if (markOk[i] && m.translation) numbersIn(m.translation).forEach((n) => allowed.add(n));
  });
  for (const [field, value] of [['title', story.title], ['summary', story.summary], ['why it matters', story.why], ['what to watch', story.next ?? '']] as const) {
    for (const n of numbersIn(value)) {
      if (!allowed.has(n)) reasons.push(`Number "${n}" in the ${field} is not in the sources.`);
    }
    const banned = bannedIn(value);
    if (banned) reasons.push(`"${banned}" is a banned word (${field}).`);
  }

  if (words(story.title) > 16) warnings.push(`Title is ${words(story.title)} words (aim for 12).`);
  if (words(story.summary) > 60) warnings.push(`Summary is ${words(story.summary)} words (aim for 40).`);
  if (words(story.why) > 45) warnings.push(`"Why it matters" is ${words(story.why)} words (aim for 30).`);

  if (reasons.length > 0) return { check: check(false), story: null };

  // A highlight is the reader's proof, so its quote must state that very value. Writers
  // sometimes number highlights wrong; a highlight is pointed at the verified quote that
  // does state it, or loses its highlight. The value itself already passed the number check.
  const proves = (i: number, inner: string): boolean => {
    const m = story.marks[i];
    if (!m || !markOk[i]) return false;
    const said = [m.quote, m.translation ?? ''];
    const numbers = numbersIn(inner);
    if (numbers.length === 0) return said.some((q) => canonical(q).includes(canonical(plainText(inner))));
    const proof = new Set(said.flatMap(numbersIn));
    return numbers.every((n) => proof.has(n));
  };
  const summary = story.summary.replace(/<m(\d+)>(.*?)<\/m\1>/g, (whole, index: string, inner: string) => {
    if (proves(Number(index), inner)) return whole;
    const other = story.marks.findIndex((_, i) => proves(i, inner));
    if (other >= 0) {
      warnings.push(`Highlight "${inner}" pointed at quote ${Number(index) + 1}; moved to quote ${other + 1}, which states it.`);
      return `<m${other}>${inner}</m${other}>`;
    }
    warnings.push(`Highlight "${inner}" removed: no quote states it.`);
    return inner;
  });

  // Questions: drop any answer with an unverified citation or an unsupported number.
  const questions = story.questions.filter((q, i) => {
    const citesOk = q.cites.length > 0 && q.cites.every((c) => verified(c, texts));
    const refsOk = tokenize(q.a).every((t) => t.type !== 'cite' || (t.n >= 1 && t.n <= q.cites.length));
    const answerNumbers = new Set(allowed);
    q.cites.forEach((c) => c.translation && numbersIn(c.translation).forEach((n) => answerNumbers.add(n)));
    const numbersOk = numbersIn(q.a).every((n) => answerNumbers.has(n));
    if (!q.q || !q.a || !citesOk || !refsOk || !numbersOk) {
      warnings.push(`Question ${i + 1} removed: ${!citesOk ? 'a citation is not in its source' : !refsOk ? 'it cites a missing source' : !numbersOk ? 'it has a number not in the sources' : 'it is empty'}.`);
      return false;
    }
    return true;
  });

  // Chart: every row must be numeric, and every shown value must come from the sources.
  let chart = story.chart;
  if (chart) {
    const rowsOk =
      chart.rows.length >= (chart.type === 'compare' ? 2 : 1) &&
      chart.rows.every((r) => Number.isFinite(r.value) && r.label && r.shown && (r.mark === undefined || markOk[r.mark]) && numbersIn(r.shown).every((n) => allowed.has(n))) &&
      (chart.type === 'change' || chart.rows.every((r) => r.value >= 0));
    if (!rowsOk || !chart.title) {
      warnings.push('Chart removed: a value is missing or not found in the sources.');
      chart = null;
    }
  }

  // Image: only the official source's own image.
  let image = story.image;
  if (image) {
    const src = story.sources[image.source];
    if (!src || src.kind !== 'official' || !sources.get(src.url)?.image || !image.alt) {
      warnings.push('Image removed: no image published by the official source.');
      image = null;
    }
  }

  return { check: check(true), story: { ...story, summary, questions, chart, image } };
}

export function checkBrief(brief: DraftBrief, index: number, sources: Map<string, SourceText>): { check: ItemCheck; brief: DraftBrief | null } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const text = sources.get(brief.url)?.text;
  if (!brief.text || !brief.url) reasons.push('Missing text or source.');
  if (!text) reasons.push('The source could not be read.');
  for (const n of numbersIn(brief.text)) {
    if (text && !numbersIn(text).includes(n)) reasons.push(`Number "${n}" is not in the source.`);
  }
  const banned = bannedIn(brief.text);
  if (banned) reasons.push(`"${banned}" is a banned word.`);
  // A rumor never carries a company logo.
  const cleaned = brief.kind === 'rumor' ? { ...brief, org: null } : brief;
  const check = { id: `brief-${index + 1}`, title: brief.text.slice(0, 90), kept: reasons.length === 0, reasons, warnings };
  return { check, brief: check.kept ? cleaned : null };
}

/** Runs check 1 over the whole draft and drops what failed. */
export function checkDraft(draft: Draft, sources: Map<string, SourceText>, recentUrls: Set<string>): { draft: Draft; checks: ItemCheck[] } {
  const checks: ItemCheck[] = [];
  const stories: DraftStory[] = [];
  for (const s of draft.stories) {
    if (s.sources.length > 0 && s.sources.every((src) => recentUrls.has(src.url))) {
      checks.push({ id: s.id, title: s.title, kept: false, reasons: ['Already covered in the last 7 days.'], warnings: [] });
      continue;
    }
    const result = checkStory(s, sources);
    checks.push(result.check);
    if (result.story) stories.push(result.story);
  }
  const briefs: DraftBrief[] = [];
  draft.briefs.forEach((b, i) => {
    if (recentUrls.has(b.url)) {
      checks.push({ id: `brief-${i + 1}`, title: b.text.slice(0, 90), kept: false, reasons: ['Already covered in the last 7 days.'], warnings: [] });
      return;
    }
    const result = checkBrief(b, i, sources);
    checks.push(result.check);
    if (result.brief) briefs.push(result.brief);
  });

  // "Today in 3" may only point at stories that survived, and its numbers must hold up too.
  const kept = new Map(stories.map((s) => [s.id, s]));
  const today = draft.today.filter((t) => {
    const story = kept.get(t.story);
    if (!story || !t.text) return false;
    const allowed = new Set<string>();
    story.sources.forEach((src) => {
      const text = sources.get(src.url)?.text;
      if (text) numbersIn(text).forEach((n) => allowed.add(n));
    });
    story.marks.forEach((m) => m.translation && numbersIn(m.translation).forEach((n) => allowed.add(n)));
    return numbersIn(t.text).every((n) => allowed.has(n)) && !bannedIn(t.text);
  });
  if (today.length === 0) stories.slice(0, 3).forEach((s) => today.push({ story: s.id, text: s.title }));

  // Exactly one top story, and it leads the issue.
  const topIndex = stories.findIndex((s) => s.top);
  if (topIndex > 0) stories.unshift(...stories.splice(topIndex, 1));
  stories.forEach((s, i) => {
    stories[i] = { ...s, top: i === 0 };
  });
  return { draft: { today: today.slice(0, 3), stories, briefs }, checks };
}
