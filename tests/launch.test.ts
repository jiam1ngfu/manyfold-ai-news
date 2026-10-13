import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueValidationError, applyCorrection, storyAt, storyPosition, validateIssue, type Issue } from '../src/shared/issue';
import { SAMPLE_ISSUE } from '../src/worker/sample-issue';
import { gateStreak } from '../src/worker/quality';
import { classify, headTags, pageMeta, sitemapXml } from '../src/worker/pages';
import { outcomeOf, verifyWebhook } from '../src/worker/email/webhook';
import { renderConfirmEmail, renderIssueEmail } from '../src/worker/email/render';
import { runAlert, type RunReport } from '../src/worker/pipeline/run';
import type { Env } from '../src/worker/types';

vi.mock('../src/worker/a2a', async (original) => ({ ...(await original<typeof import('../src/worker/a2a')>()), consumeA2AStream: vi.fn() }));
const { consumeA2AStream } = await import('../src/worker/a2a');
const { jsonTurn } = await import('../src/worker/pipeline/agent');

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const AT = '2026-10-14T09:00:00.000Z';
const note = { en: 'An earlier version gave the wrong figure.', zh: '此前版本的数字有误。' };

describe('corrections', () => {
  it('fixes a story in place, keeps its position and records the note', () => {
    const story = SAMPLE_ISSUE.stories[1];
    const fixed = applyCorrection(SAMPLE_ISSUE, { kind: 'corrected', target: story.id, note, fix: { title: { en: 'A fixed headline', zh: '更正后的标题' } } }, AT);
    expect(fixed.stories[1].id).toBe(story.id);
    expect(fixed.stories[1].title.en).toBe('A fixed headline');
    expect(fixed.stories[1].summary).toEqual(story.summary);
    // A correction is listed under the headline readers now see.
    expect(fixed.corrections).toEqual([{ at: AT, kind: 'corrected', story: story.id, title: { en: 'A fixed headline', zh: '更正后的标题' }, note }]);
    // The original is untouched.
    expect(SAMPLE_ISSUE.corrections).toBeUndefined();
  });

  it('withdraws a story and its Today-in-3 line, leaving only the notice', () => {
    const story = SAMPLE_ISSUE.stories[0];
    const out = applyCorrection(SAMPLE_ISSUE, { kind: 'withdrawn', target: story.id, note }, AT);
    expect(out.stories.some((s) => s.id === story.id)).toBe(false);
    expect(out.today.some((t) => t.id === story.id)).toBe(false);
    expect(out.corrections?.[0]).toMatchObject({ kind: 'withdrawn', story: story.id, title: story.title });
  });

  it('withdraws a brief by position, and refuses to correct one', () => {
    const out = applyCorrection(SAMPLE_ISSUE, { kind: 'withdrawn', target: 'brief-0', note }, AT);
    expect(out.briefs).toHaveLength(SAMPLE_ISSUE.briefs.length - 1);
    expect(out.corrections?.[0].title).toEqual(SAMPLE_ISSUE.briefs[0].text);
    expect(() => applyCorrection(SAMPLE_ISSUE, { kind: 'corrected', target: 'brief-0', note }, AT)).toThrow(IssueValidationError);
  });

  it('needs a note in both languages, a real target, and markers that still match', () => {
    const id = SAMPLE_ISSUE.stories[0].id;
    expect(() => applyCorrection(SAMPLE_ISSUE, { kind: 'withdrawn', target: id, note: { en: 'x', zh: '' } }, AT)).toThrow(IssueValidationError);
    expect(() => applyCorrection(SAMPLE_ISSUE, { kind: 'withdrawn', target: 'no-such-story', note }, AT)).toThrow(IssueValidationError);
    expect(() => applyCorrection(SAMPLE_ISSUE, { kind: 'corrected', target: id, note, fix: { summary: { en: 'Up <m9>9%</m9>.', zh: '上涨 <m9>9%</m9>。' } } }, AT)).toThrow(IssueValidationError);
  });

  it('will not withdraw the last item: that is unpublishing', () => {
    const one: Issue = { ...clone(SAMPLE_ISSUE), stories: [clone(SAMPLE_ISSUE.stories[0])], briefs: [], today: [] };
    expect(() => applyCorrection(one, { kind: 'withdrawn', target: one.stories[0].id, note }, AT)).toThrow(/unpublish/);
  });

  it('survives validation after a corrected story is later withdrawn', () => {
    const id = SAMPLE_ISSUE.stories[1].id;
    const corrected = applyCorrection(SAMPLE_ISSUE, { kind: 'corrected', target: id, note, fix: { why: { en: 'Because.', zh: '因为。' } } }, AT);
    const withdrawn = applyCorrection(corrected, { kind: 'withdrawn', target: id, note }, AT);
    expect(validateIssue(clone(withdrawn)).corrections).toHaveLength(2);
  });
});

describe('story positions', () => {
  it('stay as published when stories are withdrawn, so emailed links still point at the right story', () => {
    const [a, b, c] = SAMPLE_ISSUE.stories;
    const withoutB = applyCorrection(SAMPLE_ISSUE, { kind: 'withdrawn', target: b.id, note }, AT);
    expect(storyPosition(withoutB, a.id)).toBe(1);
    expect(storyPosition(withoutB, c.id)).toBe(3);
    expect(storyAt(withoutB, 2)).toMatchObject({ withdrawn: { story: b.id, slot: 2 } });
    const withoutAB = applyCorrection(withoutB, { kind: 'withdrawn', target: a.id, note }, AT);
    expect(storyAt(withoutAB, 1)).toMatchObject({ withdrawn: { story: a.id, slot: 1 } });
    expect(storyAt(withoutAB, 2)).toMatchObject({ withdrawn: { story: b.id } });
    expect(storyPosition(withoutAB, c.id)).toBe(3);
    expect(storyAt(withoutAB, 99)).toBeNull();
    // A link to a withdrawn story still opens its issue, not a 404.
    expect(pageMeta({ name: 'issue', lang: 'en', date: withoutAB.date, story: 2 }, withoutAB).status).toBe(200);
    expect(pageMeta({ name: 'issue', lang: 'en', date: withoutAB.date, story: 3 }, withoutAB).title).toContain(c.title.en);
  });
});

describe('launch gate', () => {
  const issue = (date: string, verdict: 'clean' | 'errors' | null, corrected = false) => ({ date, verdict, corrected });

  it('counts clean checks from the newest back, after the unchecked ones', () => {
    expect(gateStreak([issue('d5', null), issue('d4', 'clean'), issue('d3', 'clean'), issue('d2', 'errors'), issue('d1', 'clean')])).toEqual({ streak: 2, waiting: ['d5'], brokenBy: 'd2' });
  });

  it('treats a correction as an error whatever the check said', () => {
    expect(gateStreak([issue('d3', 'clean'), issue('d2', 'clean', true), issue('d1', 'clean')])).toEqual({ streak: 1, waiting: [], brokenBy: 'd2' });
  });

  it('stops at an unchecked issue in the middle', () => {
    expect(gateStreak([issue('d3', 'clean'), issue('d2', null), issue('d1', 'clean')])).toEqual({ streak: 1, waiting: [], brokenBy: null });
  });
});

describe('pages', () => {
  const issue = clone(SAMPLE_ISSUE);
  const site = 'https://app.manyfold.ai/ai-news';

  it('classifies the same paths as the reader router', () => {
    expect(classify('/')).toEqual({ name: 'root' });
    expect(classify('/zh/')).toEqual({ name: 'today', lang: 'zh' });
    expect(classify('/en/2026-10-13')).toEqual({ name: 'issue', lang: 'en', date: '2026-10-13', story: null });
    expect(classify('/en/2026-10-13/2')).toEqual({ name: 'issue', lang: 'en', date: '2026-10-13', story: 2 });
    expect(classify('/en/privacy')).toEqual({ name: 'privacy', lang: 'en' });
    expect(classify('/zh/corrections')).toEqual({ name: 'corrections', lang: 'zh' });
    expect(classify('/en/unsubscribe')).toEqual({ name: 'unsubscribe', lang: 'en' });
    expect(classify('/admin')).toEqual({ name: 'admin' });
    expect(classify('/fr/')).toMatchObject({ name: 'notFound' });
    expect(classify('/en/2026-10-13/x')).toMatchObject({ name: 'notFound' });
    expect(classify('/en/archive/more')).toMatchObject({ name: 'notFound' });
  });

  it('gives a story its own share card and canonical link', () => {
    const meta = pageMeta({ name: 'issue', lang: 'en', date: issue.date, story: 1 }, issue);
    expect(meta.status).toBe(200);
    expect(meta.title).toBe(`${issue.stories[0].title.en} · AI in 5`);
    expect(meta.description).not.toMatch(/<m\d>/);
    expect(meta.path).toBe(`/en/${issue.date}/1`);
    const tags = headTags(meta, site);
    expect(tags).toContain(`<link rel="canonical" href="${site}/en/${issue.date}/1">`);
    expect(tags).toContain(`<link rel="alternate" hreflang="zh-Hans" href="${site}/zh/${issue.date}/1">`);
    expect(tags).toContain(`<meta property="og:image" content="${site}/og/card-en.png">`);
    expect(tags).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it('answers 404 for a missing issue or story, and keeps link pages out of search', () => {
    expect(pageMeta({ name: 'issue', lang: 'en', date: '2026-01-01', story: null }, null).status).toBe(404);
    expect(pageMeta({ name: 'issue', lang: 'en', date: issue.date, story: 99 }, issue).status).toBe(404);
    expect(pageMeta({ name: 'notFound', lang: 'zh' }, null)).toMatchObject({ status: 404, noindex: true });
    const unsub = pageMeta({ name: 'unsubscribe', lang: 'en' }, null);
    expect(unsub.noindex).toBe(true);
    expect(headTags(unsub, site)).toContain('noindex');
    expect(headTags(unsub, site)).not.toContain('og:url');
  });

  it('escapes what goes into attributes', () => {
    const meta = { ...pageMeta({ name: 'about', lang: 'en' }, null), title: 'A "quoted" <title> & more' };
    expect(headTags(meta, site)).toContain('content="A &quot;quoted&quot; &lt;title&gt; &amp; more"');
  });

  it('lists both languages of every issue in the sitemap', () => {
    const xml = sitemapXml(site, [{ date: '2026-10-13', updatedAt: '2026-10-13T09:49:43.930Z' }]);
    expect(xml).toContain(`<loc>${site}/en/2026-10-13</loc><lastmod>2026-10-13</lastmod>`);
    expect(xml).toContain(`<loc>${site}/zh/2026-10-13</loc>`);
    expect(xml).toContain(`<loc>${site}/en/privacy</loc>`);
    expect(xml).not.toContain('unsubscribe');
  });
});

describe('bounce webhook', () => {
  const secret = `whsec_${btoa('a-very-secret-signing-key-32byte')}`;
  const sign = async (id: string, ts: string, body: string) => {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
    return `v1,${btoa(String.fromCharCode(...sig))}`;
  };

  it('accepts a fresh, correctly signed body and nothing else', async () => {
    const now = 1_760_000_000_000;
    const ts = String(now / 1000);
    const body = '{"type":"email.bounced"}';
    const signature = await sign('msg_1', ts, body);
    expect(await verifyWebhook(secret, { id: 'msg_1', timestamp: ts, signature }, body, now)).toBe(true);
    expect(await verifyWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,bogus ${signature}` }, body, now)).toBe(true);
    expect(await verifyWebhook(secret, { id: 'msg_1', timestamp: ts, signature }, `${body} `, now)).toBe(false);
    expect(await verifyWebhook(secret, { id: 'msg_2', timestamp: ts, signature }, body, now)).toBe(false);
    expect(await verifyWebhook(secret, { id: 'msg_1', timestamp: ts, signature }, body, now + 10 * 60 * 1000)).toBe(false);
    expect(await verifyWebhook(secret, { id: 'msg_1', timestamp: ts, signature: null }, body, now)).toBe(false);
  });

  it('stops email for hard bounces and complaints only', () => {
    expect(outcomeOf({ type: 'email.bounced', data: { bounce: { type: 'Permanent' } } })).toBe('bounced');
    expect(outcomeOf({ type: 'email.bounced', data: { bounce: { type: 'Transient' } } })).toBeNull();
    expect(outcomeOf({ type: 'email.complained' })).toBe('complained');
    expect(outcomeOf({ type: 'email.delivered' })).toBeNull();
  });
});

describe('emails', () => {
  it('link the privacy page and carry the postal address and recent corrections', () => {
    const correction = { at: AT, kind: 'withdrawn' as const, title: { en: 'Old <m0>headline</m0>', zh: '旧标题' }, note, date: '2026-10-12', number: 2, position: null };
    const { html, text } = renderIssueEmail(SAMPLE_ISSUE, 'en', 'https://example.com/ai-news', 'NetMind.AI Ltd, London', [correction]);
    expect(html).toContain('https://example.com/ai-news/en/privacy');
    expect(html).toContain('NetMind.AI Ltd, London');
    expect(html).toContain('https://example.com/ai-news/en/corrections');
    expect(html).toContain(note.en);
    expect(html).not.toContain('<m0>');
    expect(text).toContain('Withdrawn');
    expect(renderIssueEmail(SAMPLE_ISSUE, 'en', 'https://example.com/ai-news').html).not.toContain('/en/corrections');
    expect(renderConfirmEmail('zh', 'https://example.com/ai-news/zh/confirm?t=x', 'https://example.com/ai-news/zh/privacy').html).toContain('隐私政策');
  });
});

describe('run alerts', () => {
  const env = { SITE_URL: 'https://example.com/ai-news' } as Env;
  const report = (stories: number, briefs: number): RunReport =>
    ({ stories, briefs, checks: [], review: null, repairs: [], step: 'checking' }) as unknown as RunReport;

  it('says a failed daily run will retry, and a failed retry will not', () => {
    expect(runAlert(env, '2026-10-14-1', '2026-10-14', 'failed', report(0, 0), 'boom', 'cron').lines.join(' ')).toMatch(/retries once at 20:30/);
    expect(runAlert(env, '2026-10-14-2', '2026-10-14', 'failed', report(0, 0), 'boom', 'retry').lines.join(' ')).toMatch(/no issue for that date/);
  });

  it('warns about a thin day and links to the published issue', () => {
    const alert = runAlert(env, '2026-10-14-1', '2026-10-14', 'published', report(1, 0), null, 'cron');
    expect(alert.key).toBe('published:2026-10-14');
    expect(alert.lines.join(' ')).toMatch(/thin day/);
    expect(alert.link?.url).toBe('https://example.com/ai-news/en/2026-10-14');
  });
});

describe('JSON repair turn', () => {
  const cred = { rpcUrl: 'https://example.com/rpc', token: 't', label: 'writer' };
  const reply = (text: string) => ({ state: 'completed', text }) as Awaited<ReturnType<typeof consumeA2AStream>>;
  const mocked = vi.mocked(consumeA2AStream);
  beforeEach(() => mocked.mockReset());

  it('costs nothing extra when the reply parses', async () => {
    mocked.mockResolvedValueOnce(reply('{"items": [1]}'));
    const repaired = vi.fn();
    expect(await jsonTurn(cred, 'aiin5-run-pick', 'prompt', repaired)).toEqual({ items: [1] });
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(repaired).not.toHaveBeenCalled();
  });

  it('asks once more, under a derived messageId, when the reply cannot be repaired', async () => {
    mocked.mockResolvedValueOnce(reply('{"items": [1, 2,, 3]}')).mockResolvedValueOnce(reply('{"items": [1, 2, 3]}'));
    const repaired = vi.fn();
    expect(await jsonTurn(cred, 'aiin5-run-write', 'prompt', repaired)).toEqual({ items: [1, 2, 3] });
    expect(repaired).toHaveBeenCalledOnce();
    const second = mocked.mock.calls[1][0] as unknown as { params: { message: { messageId: string; parts: { text: string }[] } } };
    expect(second.params.message.messageId).toBe('aiin5-run-write-fix');
    expect(second.params.message.parts[0].text).toContain('{"items": [1, 2,, 3]}');
  });
});
