/**
 * Turns the checked English draft plus the Chinese translations into an Issue.
 * Check 3 of 3 runs here: a translation that drops a marker or changes the numbers is
 * repaired (markers stripped) or flagged, so the Chinese edition never claims more
 * than the English one.
 */

import type { Brief, ChartRow, Issue, L10n, Place, Quote, RegionKey, Source, Story, Visual } from '../../shared/issue';
import { tokenize } from '../../shared/issue';
import { repairMarkers, type Draft, type DraftQuote, type DraftStory } from './draft';
import { extraQuantities } from './checks';
import { findOrg } from './orgs';

const CATEGORY_ZH: Record<string, string> = {
  Models: '模型',
  Products: '产品',
  Companies: '公司',
  Funding: '融资',
  Research: '研究',
  'Open Source': '开源',
  Policy: '政策',
  Hardware: '硬件',
};

const REGION_CENTRE: Record<RegionKey, Place> = {
  us: { lon: -98, lat: 39 },
  cn: { lon: 105, lat: 35 },
  eu: { lon: 10, lat: 50 },
  jp: { lon: 139, lat: 36 },
  other: { lon: 0, lat: 20 },
};

function place(region: RegionKey, lon: number | null, lat: number | null): Place {
  return lon !== null && lat !== null && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? { lon, lat } : REGION_CENTRE[region];
}

/** "Official announcement, plus 2 reports" — counted, never written by the model. */
export function sourceLine(sources: { kind: string }[]): L10n {
  const official = sources.filter((s) => s.kind === 'official').length;
  const others = sources.length - official;
  if (official > 0) {
    return others > 0
      ? { en: `Official announcement, plus ${others} ${others === 1 ? 'report' : 'reports'}`, zh: `官方公告，另有 ${others} 家媒体报道` }
      : { en: 'Official announcement', zh: '官方公告' };
  }
  return { en: `${others} ${others === 1 ? 'report' : 'reports'}`, zh: `${others} 家媒体报道` };
}

/** Every string the translator needs, keyed by where it goes. */
export function translationEntries(draft: Draft, sourceNamesZh: Map<string, string>): Record<string, string> {
  const e: Record<string, string> = {};
  draft.today.forEach((t, i) => (e[`today.${i}`] = t.text));
  draft.stories.forEach((s, i) => {
    const k = `s${i}`;
    e[`${k}.title`] = s.title;
    e[`${k}.summary`] = s.summary;
    e[`${k}.why`] = s.why;
    if (s.next) e[`${k}.next`] = s.next;
    s.sources.forEach((src, j) => {
      if (!sourceNamesZh.has(src.url)) e[`${k}.src${j}`] = src.name;
    });
    const quote = (q: DraftQuote, key: string) => {
      const lang = s.sources[q.source]?.lang ?? 'en';
      if (lang !== 'zh') e[key] = lang === 'en' ? q.quote : q.translation ?? q.quote;
    };
    s.marks.forEach((m, j) => quote(m, `${k}.mark${j}`));
    if (s.chart) {
      e[`${k}.chart.title`] = s.chart.title;
      if (s.chart.note) e[`${k}.chart.note`] = s.chart.note;
      s.chart.rows.forEach((r, j) => (e[`${k}.chart.row${j}`] = r.label));
    }
    if (s.image) e[`${k}.image.alt`] = s.image.alt;
    s.questions.forEach((q, j) => {
      e[`${k}.q${j}.q`] = q.q;
      e[`${k}.q${j}.a`] = q.a;
      q.cites.forEach((c, n) => quote(c, `${k}.q${j}.cite${n}`));
    });
  });
  draft.briefs.forEach((b, i) => {
    e[`b${i}.text`] = b.text;
    if (!sourceNamesZh.has(b.url)) e[`b${i}.src`] = b.sourceName;
  });
  return e;
}

/** Check 3: markers and numbers must survive translation. */
export function checkTranslation(key: string, en: string, zh: string | undefined, warnings: string[]): string {
  if (!zh) {
    warnings.push(`${key}: no Chinese translation; the English text is used.`);
    return en;
  }
  let out = repairMarkers(zh);
  const marks = (s: string) => tokenize(s).filter((t) => t.type === 'mark').map((t) => (t.type === 'mark' ? t.index : -1)).sort().join(',');
  const cites = (s: string) => tokenize(s).filter((t) => t.type === 'cite').map((t) => (t.type === 'cite' ? t.n : -1)).sort().join(',');
  if (marks(en) !== marks(out)) {
    warnings.push(`${key}: the translation changed the checked-number markers; highlights removed in Chinese.`);
    out = out.replace(/<\/?m\d+>?/g, '');
  }
  if (cites(en) !== cites(out) && cites(en) !== '') {
    warnings.push(`${key}: the translation changed the citations; citation numbers removed in Chinese.`);
    out = out.replace(/\[\d+\]/g, '');
  }
  const extra = extraQuantities(en, out);
  if (extra.length > 0) warnings.push(`${key}: the Chinese states values the English does not (${extra.join(', ')}). Check the translation.`);
  return out;
}

export function assembleIssue(options: {
  date: string;
  number: number;
  draft: Draft;
  zh: Record<string, string>;
  sourceNamesZh: Map<string, string>;
  images: Map<string, string>;
}): { issue: Issue; warnings: string[] } {
  const { draft, zh, sourceNamesZh, images } = options;
  const warnings: string[] = [];
  const both = (key: string, en: string): L10n => ({ en, zh: checkTranslation(key, en, zh[key], warnings) });

  const stories: Story[] = draft.stories.map((s: DraftStory, i): Story => {
    const k = `s${i}`;
    const org = findOrg(s.org);
    const sources: Source[] = s.sources.map((src, j) => ({
      kind: src.kind,
      name: { en: src.name, zh: sourceNamesZh.get(src.url) ?? zh[`${k}.src${j}`] ?? src.name },
      lang: src.lang,
      time: src.published && !Number.isNaN(Date.parse(src.published)) ? new Date(src.published).toISOString() : new Date(`${options.date}T00:00:00Z`).toISOString(),
      url: src.url,
    }));
    const quote = (q: DraftQuote, key: string): Quote => {
      const lang = s.sources[q.source]?.lang ?? 'en';
      const tr: Partial<L10n> = {};
      if (lang !== 'en' && q.translation) tr.en = q.translation;
      if (lang !== 'zh' && zh[key]) tr.zh = zh[key];
      return { src: q.source, quote: q.quote, ...(Object.keys(tr).length ? { tr } : {}) };
    };
    let visual: Visual | undefined;
    if (s.chart) {
      const rows: ChartRow[] = s.chart.rows.map((r, j) => ({
        label: both(`${k}.chart.row${j}`, r.label),
        value: r.value,
        shown: { en: r.shown, zh: r.shown },
        ...(r.mark !== undefined ? { mark: r.mark } : {}),
        ...(r.focus ? { focus: true } : {}),
      }));
      const from = s.sources[0];
      const credit = { en: `Chart: AI in 5, from ${from.name}`, zh: `图表：AI in 5，数据来自${sourceNamesZh.get(from.url) ?? from.name}` };
      visual =
        s.chart.type === 'compare'
          ? { type: 'compare', title: both(`${k}.chart.title`, s.chart.title), ...(s.chart.note ? { note: both(`${k}.chart.note`, s.chart.note) } : {}), rows, credit }
          : { type: 'change', title: both(`${k}.chart.title`, s.chart.title), axis: { en: ['Decrease', 'Increase'], zh: ['减少', '增加'] }, rows, credit };
    } else if (s.image) {
      const src = s.sources[s.image.source];
      const image = src ? images.get(src.url) : undefined;
      if (image) {
        const who = org?.name ?? s.org ?? src.name;
        visual = { type: 'image', src: image, alt: both(`${k}.image.alt`, s.image.alt), credit: { en: `Image: ${who}, from its announcement`, zh: `图片：${who}，取自官方公告` } };
      }
    }
    return {
      id: s.id,
      region: s.region,
      ...(s.top ? { top: true } : {}),
      ...(org ? { org } : {}),
      place: place(s.region, s.lon, s.lat),
      cat: { en: s.category, zh: CATEGORY_ZH[s.category] ?? s.category },
      title: both(`${k}.title`, s.title),
      summary: both(`${k}.summary`, s.summary),
      why: both(`${k}.why`, s.why),
      ...(s.next ? { next: both(`${k}.next`, s.next) } : {}),
      sourceLine: sourceLine(s.sources),
      sources,
      marks: s.marks.map((m, j) => quote(m, `${k}.mark${j}`)),
      ...(visual ? { visual } : {}),
      ask: s.questions.map((q, j) => ({
        status: q.status,
        cites: q.cites.map((c, n) => quote(c, `${k}.q${j}.cite${n}`)),
        q: both(`${k}.q${j}.q`, q.q),
        a: both(`${k}.q${j}.a`, q.a),
      })),
    };
  });

  const briefs: Brief[] = draft.briefs.map((b, i) => {
    // A rumor never carries a company logo: it would read as an official statement.
    const org = b.kind === 'rumor' ? undefined : findOrg(b.org);
    return {
      region: b.region,
      kind: b.kind,
      ...(org ? { org } : {}),
      place: place(b.region, b.lon, b.lat),
      src: { en: b.sourceName, zh: sourceNamesZh.get(b.url) ?? zh[`b${i}.src`] ?? b.sourceName },
      text: both(`b${i}.text`, b.text),
    };
  });

  const today = draft.today.map((t, i) => ({ id: t.story, text: both(`today.${i}`, t.text) }));
  return { issue: { date: options.date, number: options.number, today, stories, briefs }, warnings };
}
