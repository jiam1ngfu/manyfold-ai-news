import { describe, expect, it } from 'vitest';
import { NO_IMAGE_HOSTS, parseFeed, parseNewsroom } from '../src/worker/pipeline/feeds';
import { looksLikeDefaultImage } from '../src/worker/pipeline/snapshot';
import { canonical, checkDraft, checkStory, extraQuantities, numbersIn, quantities, quoteFound } from '../src/worker/pipeline/checks';
import { extractJson, readDraft, repairMarkers, type DraftStory } from '../src/worker/pipeline/draft';
import { assembleIssue, checkTranslation, sourceLine, translationEntries } from '../src/worker/pipeline/assemble';
import { issueDateFor, windowFor } from '../src/worker/pipeline/run';
import { applyReview, readReview } from '../src/worker/pipeline/review';
import { reviewPrompt } from '../src/worker/pipeline/prompts';
import { validateIssue } from '../src/shared/issue';

const SOURCE_EN =
  'Today we are releasing Q3. Running cost is about one-eighth that of comparable closed models, and the full model needs eight 80GB GPUs. ' +
  'On coding and math benchmarks it scores within 3 points of leading closed models. The weights use a license that permits commercial use. ' +
  'Reviewers spent 35% less time on code review.';
const SOURCE_ZH = '麒麟实验室今天发布 Q3。推理成本约为同级闭源模型的八分之一，完整模型需 8 张 80GB GPU。';

const sources = new Map([
  ['https://lab.example/q3', { text: SOURCE_EN, image: 'https://lab.example/q3.png' }],
  ['https://lab.example/zh', { text: SOURCE_ZH }],
]);

function story(overrides: Partial<DraftStory> = {}): DraftStory {
  return {
    id: 'q3',
    region: 'cn',
    top: true,
    org: 'Qilin Lab',
    lon: 120.16,
    lat: 30.27,
    category: 'Open Source',
    title: 'Qilin Lab releases Q3 at one-eighth the running cost',
    summary: 'Q3 costs <m0>one-eighth</m0> as much to run and scores within <m1>3 points</m1> of closed models.',
    why: 'Self-hosting a near-frontier model gets cheaper.',
    next: null,
    sources: [
      { url: 'https://lab.example/q3', name: 'Qilin Lab blog', kind: 'official', lang: 'en', published: '2026-10-11T14:10:00Z' },
      { url: 'https://lab.example/zh', name: '麒麟实验室', kind: 'official', lang: 'zh', published: '2026-10-11T14:10:00Z' },
    ],
    marks: [
      { source: 0, quote: 'Running cost is about one-eighth that of comparable closed models' },
      { source: 0, quote: 'it scores within 3 points of leading closed models' },
    ],
    chart: null,
    image: null,
    questions: [
      {
        q: 'Can I run it myself?',
        status: 'answered',
        a: 'Yes. The license permits commercial use[1], and the full model needs eight 80GB GPUs[2].',
        cites: [
          { source: 0, quote: 'The weights use a license that permits commercial use.' },
          { source: 1, quote: '完整模型需 8 张 80GB GPU', translation: 'The full model needs 8 80GB GPUs' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('parseFeed', () => {
  it('reads RSS items with CDATA and entities', () => {
    const xml = `<rss><channel><item><title><![CDATA[Model &amp; chip news]]></title><link>https://a.example/1</link>
      <pubDate>Fri, 09 Oct 2026 07:00:00 GMT</pubDate><description><![CDATA[<p>Hello <b>world</b></p>]]></description></item></channel></rss>`;
    expect(parseFeed(xml)).toEqual([{ title: 'Model & chip news', link: 'https://a.example/1', published: '2026-10-09T07:00:00.000Z', summary: 'Hello world' }]);
  });

  it('reads Atom entries with link href', () => {
    const xml = `<feed><entry><title>Atom post</title><link rel="alternate" href="https://b.example/2"/><updated>2026-10-09T14:25:43+00:00</updated><summary>Short</summary></entry></feed>`;
    expect(parseFeed(xml)[0]).toMatchObject({ title: 'Atom post', link: 'https://b.example/2', published: '2026-10-09T14:25:43.000Z' });
  });
});

describe('parseNewsroom', () => {
  it('reads dated article cards from a listing page and skips labels', () => {
    const html = `
      <a href="/news/cyber-verification-program" class="grid"><span>Announcements</span><time>Oct 6, 2026</time><h3>Expanding the Cyber Verification Program</h3><p>We’re launching a new version.</p></a>
      <a href="/news/2026-usage-policy-update" class="list"><span>Oct 8, 2026</span><span>Announcements</span><span>2026 Usage Policy update</span></a>
      <a href="/news/2026-usage-policy-update" class="list">duplicate</a>
      <a href="/careers">Careers</a>
      <a href="/news/no-date"><span>Undated card</span></a>`;
    const items = parseNewsroom(html, 'https://www.anthropic.com', /^\/news\/[a-z0-9-]+$/);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'Expanding the Cyber Verification Program',
      link: 'https://www.anthropic.com/news/cyber-verification-program',
      published: '2026-10-06T12:00:00.000Z',
      summary: 'We’re launching a new version.',
    });
    expect(items[1].title).toBe('2026 Usage Policy update');
  });

  it('accepts absolute links and full month names', () => {
    const html = `<a href="https://ai.meta.com/blog/introducing-muse-spark/" data-x="1"><div>Research</div><div>Introducing Muse Spark 1.1</div><div>July 9, 2026</div></a>`;
    const [item] = parseNewsroom(html, 'https://ai.meta.com', /^(https:\/\/ai\.meta\.com)?\/blog\/[a-z0-9-]+\/?$/);
    expect(item).toMatchObject({ title: 'Introducing Muse Spark 1.1', link: 'https://ai.meta.com/blog/introducing-muse-spark/', published: '2026-07-09T12:00:00.000Z' });
  });
});

describe('share images', () => {
  it('recognizes site-default and logo images by name', () => {
    expect(looksLikeDefaultImage('https://cdn.example/68309ab48369f7ad9b4a40e1_open-graph.jpg')).toBe(true);
    expect(looksLikeDefaultImage('https://storage.example/images/SocialShare_gradient.max-1440x810.jpg')).toBe(true);
    expect(looksLikeDefaultImage('https://www.example.com/api/opengraph-illustration?name=Hand%20Lock')).toBe(true);
    expect(looksLikeDefaultImage('https://storage.example/images/CloudGeminiAgent_hero.max-1440x810.png')).toBe(false);
  });

  it('never takes images from sites that only publish logos', () => {
    expect(NO_IMAGE_HOSTS.has('www.anthropic.com')).toBe(true);
    expect(NO_IMAGE_HOSTS.has('blog.google')).toBe(false);
  });
});

describe('quote and number matching', () => {
  it('ignores spacing, case, curly quotes and dashes', () => {
    expect(canonical('It’s  a — test')).toBe("it'sa-test");
    expect(quoteFound('RUNNING cost is about one‑eighth', SOURCE_EN)).toBe(true);
    expect(quoteFound('推理成本约为同级闭源模型的八分之一', SOURCE_ZH)).toBe(true);
  });

  it('accepts quotes that skip text with an ellipsis, in order only', () => {
    expect(quoteFound('Today we are releasing Q3… eight 80GB GPUs', SOURCE_EN)).toBe(true);
    expect(quoteFound('eight 80GB GPUs… Today we are releasing Q3', SOURCE_EN)).toBe(false);
  });

  it('normalizes numbers the way they are written', () => {
    expect(numbersIn('1,200 developers, 3.5x, 70B and <m0>35%</m0>[2]')).toEqual(['1200', '3.5', '70', '35']);
  });
});

describe('check 1: checkStory', () => {
  it('keeps a story whose quotes and numbers are all in the sources', () => {
    const { check, story: kept } = checkStory(story(), sources);
    expect(check.reasons).toEqual([]);
    expect(check.kept).toBe(true);
    expect(kept?.questions).toHaveLength(1);
  });

  it('removes a highlight whose quote does not contain its number, and keeps the story', () => {
    const swapped = story({
      marks: [
        { source: 0, quote: 'Running cost is about one-eighth that of comparable closed models' },
        { source: 0, quote: 'The weights use a license that permits commercial use.' },
      ],
    });
    const { check, story: kept } = checkStory(swapped, sources);
    expect(check.kept).toBe(true);
    expect(kept?.summary).toBe('Q3 costs <m0>one-eighth</m0> as much to run and scores within 3 points of closed models.');
    expect(check.warnings.join(' ')).toContain('Highlight 1 ("3 points") removed');
  });

  it('drops a story with an invented number', () => {
    const { check } = checkStory(story({ why: 'It could save companies 90% of their bill.' }), sources);
    expect(check.kept).toBe(false);
    expect(check.reasons.join(' ')).toMatch(/Number "90"/);
  });

  it('drops a story whose mark quote is not in the source', () => {
    const { check } = checkStory(story({ marks: [{ source: 0, quote: 'costs a tenth as much' }, { source: 0, quote: 'within 3 points' }] }), sources);
    expect(check.kept).toBe(false);
    expect(check.reasons.join(' ')).toMatch(/mark 0/);
  });

  it('drops a story built only on rumors', () => {
    const s = story();
    const { check } = checkStory({ ...s, sources: s.sources.map((src) => ({ ...src, kind: 'rumor' as const })) }, sources);
    expect(check.kept).toBe(false);
  });

  it('removes a question with an unverifiable citation but keeps the story', () => {
    const s = story();
    const bad = { ...s.questions[0], cites: [{ source: 0, quote: 'free for everyone' }, s.questions[0].cites[1]] };
    const { check, story: kept } = checkStory({ ...s, questions: [bad] }, sources);
    expect(check.kept).toBe(true);
    expect(kept?.questions).toHaveLength(0);
    expect(check.warnings.join(' ')).toMatch(/Question 1 removed/);
  });

  it('removes an image unless the official source published one', () => {
    const { story: withImage } = checkStory(story({ image: { source: 0, alt: 'Launch image' } }), sources);
    expect(withImage?.image).not.toBeNull();
    const { story: without } = checkStory(story({ image: { source: 1, alt: 'No image here' } }), sources);
    expect(without?.image).toBeNull();
  });

  it('refuses hype words', () => {
    const { check } = checkStory(story({ title: 'A game-changer: Qilin Lab releases Q3' }), sources);
    expect(check.kept).toBe(false);
  });
});

describe('checkDraft', () => {
  it('drops stories already covered this week and keeps exactly one top story', () => {
    const a = story({ id: 'a', top: false });
    const b = story({ id: 'b', top: true });
    const old = story({ id: 'old', sources: [{ ...a.sources[0], url: 'https://lab.example/old' }] });
    const result = checkDraft({ today: [], stories: [a, b, old], briefs: [] }, sources, new Set(['https://lab.example/old']));
    expect(result.draft.stories.map((s) => s.id)).toEqual(['b', 'a']);
    expect(result.draft.stories.map((s) => s.top)).toEqual([true, false]);
    expect(result.checks.find((c) => c.id === 'old')?.reasons).toEqual(['Already covered in the last 7 days.']);
    expect(result.draft.today.length).toBeGreaterThan(0);
  });
});

describe('check 2: review', () => {
  const brief = { region: 'cn' as const, org: 'Qilin Lab', lon: null, lat: null, kind: 'official' as const, text: 'Qilin Lab released Q3 under a commercial license.', sourceName: 'Qilin Lab blog', url: 'https://lab.example/q3' };
  const makeDraft = () => ({
    today: [
      { story: 'a', text: 'Qilin Lab releases Q3.' },
      { story: 'b', text: 'Q3 runs on eight GPUs.' },
    ],
    stories: [story({ id: 'a' }), story({ id: 'b', top: false }), story({ id: 'c', top: false })],
    briefs: [brief, { ...brief, text: 'Q3 needs eight 80GB GPUs.' }],
  });

  it('reads verdicts and treats anything unknown as a cut', () => {
    const verdicts = readReview({ items: [{ id: 'a', verdict: 'pass' }, { id: 'b', verdict: 'maybe' }, { id: 'a', verdict: 'cut' }, { verdict: 'pass' }] });
    expect([...verdicts.verdicts.keys()]).toEqual(['a', 'b']);
    expect(verdicts.verdicts.get('a')?.verdict).toBe('pass');
    expect(verdicts.verdicts.get('b')?.verdict).toBe('cut');
    expect(verdicts.top).toBeNull();
  });

  it('applies pass, fix and cut, and cuts what was not judged', () => {
    const verdicts = readReview({
      items: [
        { id: 'a', verdict: 'pass' },
        { id: 'b', verdict: 'fix', problems: ['"why" overstates'], fix: { why: 'Running it costs less, by the company\'s own account.', today: 'Q3 needs eight 80GB GPUs.' }, remove: ['q0'] },
        { id: 'brief-1', verdict: 'cut', problems: ['Same event as story a.'] },
      ],
    });
    const { draft, review } = applyReview(makeDraft(), verdicts, sources, 'reviewer');
    expect(draft.stories.map((s) => s.id)).toEqual(['a', 'b']);
    expect(draft.stories[1].why).toBe("Running it costs less, by the company's own account.");
    expect(draft.stories[1].questions).toHaveLength(0);
    expect(draft.today.find((t) => t.story === 'b')?.text).toBe('Q3 needs eight 80GB GPUs.');
    expect(draft.briefs).toHaveLength(0);
    const byId = new Map(review.items.map((i) => [i.id, i]));
    expect(byId.get('b')?.changed).toEqual(['why', 'today', 'removed q0']);
    expect(byId.get('c')).toMatchObject({ verdict: 'missing', kept: false });
    expect(byId.get('brief-2')).toMatchObject({ verdict: 'missing', kept: false });
    expect(byId.get('brief-1')).toMatchObject({ verdict: 'cut', kept: false, problems: ['Same event as story a.'] });
  });

  it('runs check 1 again, so a fix cannot bring in a number the sources lack', () => {
    const verdicts = readReview({
      items: [
        { id: 'a', verdict: 'fix', fix: { summary: 'Q3 costs <m0>one-eighth</m0> as much and beats closed models by 40 points.' } },
        { id: 'b', verdict: 'pass' },
        { id: 'c', verdict: 'fix', fix: { colour: 'blue' } },
        { id: 'brief-1', verdict: 'fix', fix: { text: 'Q3 needs 12 GPUs.' } },
        { id: 'brief-2', verdict: 'pass' },
      ],
    });
    const { draft, review } = applyReview(makeDraft(), verdicts, sources, 'reviewer');
    expect(draft.stories.map((s) => s.id)).toEqual(['b']);
    expect(draft.stories[0].top).toBe(true);
    const byId = new Map(review.items.map((i) => [i.id, i]));
    expect(byId.get('a')?.kept).toBe(false);
    expect(byId.get('a')?.notes.join(' ')).toContain('Number "40"');
    expect(byId.get('c')?.notes.join(' ')).toContain('gave none that applies');
    expect(byId.get('brief-1')?.kept).toBe(false);
    expect(byId.get('brief-2')?.kept).toBe(true);
    expect(draft.briefs.map((b) => b.text)).toEqual(['Q3 needs eight 80GB GPUs.']);
  });

  it('lets the reviewer move the lead to a story that survived', () => {
    const pass = (id: string) => ({ id, verdict: 'pass' });
    const moved = applyReview(makeDraft(), readReview({ top: 'c', items: ['a', 'b', 'c', 'brief-1', 'brief-2'].map(pass) }), sources, 'reviewer');
    expect(moved.draft.stories.map((s) => [s.id, s.top])).toEqual([['c', true], ['a', false], ['b', false]]);
    expect(moved.review.top).toEqual({ from: 'a', to: 'c' });
    const cut = applyReview(makeDraft(), readReview({ top: 'c', items: [...['a', 'b', 'brief-1', 'brief-2'].map(pass), { id: 'c', verdict: 'cut' }] }), sources, 'reviewer');
    expect(cut.draft.stories[0].id).toBe('a');
    expect(cut.review.top).toBeUndefined();
  });

  it('gives the reviewer every item id with its source text', () => {
    const prompt = reviewPrompt('2026-10-12', makeDraft(), sources);
    for (const id of ['"id":"a"', '"id":"b"', '"id":"c"', '"id":"brief-1"', '"id":"brief-2"']) expect(prompt).toContain(id);
    expect(prompt).toContain('Running cost is about one-eighth');
  });
});

describe('agent output', () => {
  it('extracts JSON from a fenced reply', () => {
    expect(extractJson('Here you go:\n```json\n{"items":[1]}\n```')).toEqual({ items: [1] });
  });

  it('repairs a closing marker missing its ">" or "/", and nothing else', () => {
    expect(repairMarkers('seeks more than <m0>$250 million</m0 in damages.')).toBe('seeks more than <m0>$250 million</m0> in damages.');
    expect(repairMarkers('raised <m1>$2 billion<m1> today')).toBe('raised <m1>$2 billion</m1> today');
    expect(repairMarkers('<m0>one</m0> and <m10>two</m10>')).toBe('<m0>one</m0> and <m10>two</m10>');
    const draft = readDraft({ stories: [{ title: 'T', summary: 'Costs <m0>$5</m0 a month.' }] });
    expect(draft.stories[0].summary).toBe('Costs <m0>$5</m0> a month.');
  });

  it('coerces a loose draft and gives every story a unique id', () => {
    const draft = readDraft({ stories: [{ title: 'Same title' }, { title: 'Same title' }], briefs: [], today: [] });
    expect(new Set(draft.stories.map((s) => s.id)).size).toBe(2);
  });
});

describe('check 3: quantities', () => {
  it('treats unit conversions, month names and number words as the same value', () => {
    expect(extraQuantities('Arena raises $200 million at a $3.1 billion valuation', 'Arena 融资 2 亿美元，估值达 31 亿美元')).toEqual([]);
    expect(extraQuantities('seeking more than $250 million', '索赔超过 2.5 亿美元')).toEqual([]);
    expect(extraQuantities('takes effect on November 12', '将于 11 月 12 日生效')).toEqual([]);
    expect(extraQuantities('dismissed three researchers', '解雇了 3 名研究人员')).toEqual([]);
    expect(extraQuantities('a 70B model', '700 亿参数模型')).toEqual([]);
    expect(extraQuantities('30 million users', '3,000 万用户')).toEqual([]);
  });

  it('still flags a value the English never stated', () => {
    expect(extraQuantities('saves 30%', '节省 40%')).toEqual([40]);
    expect(extraQuantities('$200 million', '20 亿美元')).toEqual([2e9]);
  });

  it('reads English scales and suffixes', () => {
    expect(quantities('$3.1 billion, 70B, 1,200 devs, 5 minutes', 'en')).toEqual([3.1e9, 7e10, 1200, 5]);
  });
});

describe('check 3 and assembly', () => {
  it('strips markers the translation broke and flags new numbers', () => {
    const warnings: string[] = [];
    expect(checkTranslation('s0.summary', 'costs <m0>one-eighth</m0>', '成本只有八分之一', warnings)).toBe('成本只有八分之一');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/markers/);
    expect(checkTranslation('s0.why', 'saves 30%', '节省 40%', warnings)).toBe('节省 40%');
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatch(/40/);
    const clean: string[] = [];
    checkTranslation('s0.title', 'saves 30%', '节省 30%', clean);
    expect(clean).toEqual([]);
  });

  it('counts the source line instead of trusting the model', () => {
    expect(sourceLine([{ kind: 'official' }, { kind: 'reported' }, { kind: 'reported' }])).toEqual({ en: 'Official announcement, plus 2 reports', zh: '官方公告，另有 2 家媒体报道' });
  });

  it('assembles a valid bilingual issue', () => {
    const checked = checkDraft({ today: [{ story: 'q3', text: 'Qilin released Q3.' }], stories: [story()], briefs: [] }, sources, new Set());
    const entries = translationEntries(checked.draft, new Map());
    const zh = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, `中文:${v}`]));
    const { issue } = assembleIssue({ date: '2026-10-12', number: 1, draft: checked.draft, zh, sourceNamesZh: new Map(), images: new Map() });
    expect(() => validateIssue(issue)).not.toThrow();
    expect(issue.stories[0].summary.zh).toContain('<m0>');
    expect(issue.stories[0].marks[0].tr?.zh).toBeTruthy();
    expect(issue.stories[0].ask[0].cites[1].tr?.en).toBe('The full model needs 8 80GB GPUs');
  });
});

describe('schedule', () => {
  it('a 19:30 UTC run prepares the next morning, Mondays cover the weekend', () => {
    const at = new Date('2026-10-11T19:30:00Z');
    expect(issueDateFor(at)).toBe('2026-10-12');
    const window = windowFor('2026-10-12', at);
    expect((window.to.getTime() - window.from.getTime()) / 3_600_000).toBe(72);
    expect(issueDateFor(new Date('2026-10-12T10:00:00Z'))).toBe('2026-10-12');
  });
});
