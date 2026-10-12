/**
 * The daily pipeline: collect → pick (writer) → fetch sources → write (writer) →
 * check 1 (code) → check 2 (review agent, then check 1 again) → translate (writer) →
 * check 3 (code) → save as a DRAFT.
 *
 * Nothing here publishes. While the pipeline is in its trial period every issue stays
 * a draft until the owner reads it and publishes it from /admin.
 *
 * Each run is one row in pipeline_runs; its id seeds the A2A messageIds, so retrying a
 * step of the same run cannot bill twice. Four agent turns per run, all billed: three
 * on the writer, one on the reviewer, which must be a different agent.
 */

import type { Env } from '../types';
import { ensureSchema, getSetting, now, setSetting } from '../db';
import { listConnectedAgents, credentialFor } from '../connect';
import { safeErrorText } from '../a2a';
import { saveIssue } from '../issues';
import { validateIssue, type SourceKind } from '../../shared/issue';
import { NO_IMAGE_HOSTS, collectCandidates, isMediaUrl, type Candidate, type FeedResult } from './feeds';
import { orgForUrl } from './orgs';
import { fetchSnapshots, genericImages, type Snapshot } from './snapshot';
import { reviewPrompt, selectPrompt, translatePrompt, writePrompt, type WriteItem } from './prompts';
import { agentTurn } from './agent';
import { extractJson, readDraft } from './draft';
import { checkDraft, pinOfficial, type ItemCheck } from './checks';
import { assembleIssue, translationEntries } from './assemble';
import { applyReview, readReview, type ReviewReport } from './review';

export const WRITER_AGENT_KEY = 'pipeline_writer_agent';
export const REVIEWER_AGENT_KEY = 'pipeline_reviewer_agent';

export interface RunReport {
  issueDate: string;
  agent: string | null;
  reviewer: string | null;
  window: { from: string; to: string };
  feeds: FeedResult[];
  candidates: number;
  picked: number;
  sourcesFetched: number;
  sourceFailures: { url: string; error: string }[];
  /** Share images dropped as logos or site defaults rather than pictures of the story. */
  genericImages: number;
  checks: ItemCheck[];
  /** Check 2: one verdict per item from the review agent. */
  review: ReviewReport | null;
  translationWarnings: string[];
  stories: number;
  briefs: number;
  saved: 'draft' | null;
  durationMs: number;
  step: string;
}

const MIN_STORIES = 3;
const MAX_SOURCES_PER_ITEM = 3;
// Workers allow 50 outbound requests per invocation on the free plan: 16 feeds + this
// many source pages + 4 agent turns stays under it.
const MAX_SOURCE_FETCHES = 26;

/**
 * The pages one item is written from: official candidates, then the first-hand pages the
 * picker found, then reports. The per-item cap never drops a first-hand source for a
 * third report of the same event.
 */
export function itemUrls(chosen: Candidate[], extra: string[]): string[] {
  const official = chosen.filter((c) => c.kind === 'official').map((c) => c.link);
  const reports = chosen.filter((c) => c.kind !== 'official').map((c) => c.link);
  const ordered = [...official, ...extra.filter((u) => !isMediaUrl(u)), ...reports, ...extra.filter(isMediaUrl)];
  return [...new Set(ordered)].slice(0, MAX_SOURCES_PER_ITEM);
}

/** A page the picker added: a news site's page is a report, anything else first-hand. */
export function extraSource(url: string): { name: string; kind: SourceKind } {
  return { name: orgForUrl(url) ?? new URL(url).hostname.replace(/^www\./, ''), kind: isMediaUrl(url) ? 'reported' : 'official' };
}

/** The issue a run started now prepares: the morning after 19:30 UTC, today before it. */
export function issueDateFor(at: Date): string {
  return new Date(at.getTime() + 4.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** News window: since the previous run, or since Friday's for a Monday issue. */
export function windowFor(issueDate: string, at: Date): { from: Date; to: Date } {
  const monday = new Date(`${issueDate}T00:00:00Z`).getUTCDay() === 1;
  return { from: new Date(at.getTime() - (monday ? 72 : 30) * 60 * 60 * 1000), to: at };
}

export async function writerAgentId(env: Env): Promise<string | null> {
  const chosen = await getSetting(env, WRITER_AGENT_KEY);
  const agents = await listConnectedAgents(env);
  if (chosen && agents.some((a) => a.agentId === chosen)) return chosen;
  return agents.length === 1 ? agents[0].agentId : null;
}

export const setWriterAgent = (env: Env, agentId: string) => setSetting(env, WRITER_AGENT_KEY, agentId);

/** The review agent is never chosen implicitly, and never the writer itself. */
export async function reviewerAgentId(env: Env): Promise<string | null> {
  const chosen = await getSetting(env, REVIEWER_AGENT_KEY);
  if (!chosen || chosen === (await writerAgentId(env))) return null;
  const agents = await listConnectedAgents(env);
  return agents.some((a) => a.agentId === chosen) ? chosen : null;
}

export const setReviewerAgent = (env: Env, agentId: string) => setSetting(env, REVIEWER_AGENT_KEY, agentId);

/** What the last 7 days of issues already covered: their source URLs and headlines. */
async function recentCoverage(env: Env, issueDate: string): Promise<{ urls: Set<string>; headlines: string[] }> {
  const since = new Date(Date.parse(`${issueDate}T00:00:00Z`) - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare('SELECT data FROM issues WHERE date >= ? AND date < ?').bind(since, issueDate).all<{ data: string }>();
  const urls = new Set<string>();
  const headlines: string[] = [];
  for (const row of results) {
    const issue = JSON.parse(row.data) as { stories: { title: { en: string }; sources: { url: string }[] }[]; briefs?: { text: { en: string } }[] };
    issue.stories.forEach((s) => {
      headlines.push(s.title.en);
      s.sources.forEach((src) => urls.add(src.url));
    });
    issue.briefs?.forEach((b) => headlines.push(b.text.en));
  }
  return { urls, headlines };
}

async function nextNumber(env: Env, issueDate: string): Promise<number> {
  const existing = await env.DB.prepare('SELECT number FROM issues WHERE date = ?').bind(issueDate).first<{ number: number }>();
  if (existing) return existing.number;
  const row = await env.DB.prepare('SELECT MAX(number) AS n FROM issues').first<{ n: number | null }>();
  return (row?.n ?? 0) + 1;
}

async function finish(env: Env, runId: string, status: 'drafted' | 'failed', report: RunReport, error: string | null): Promise<void> {
  await env.DB.prepare('UPDATE pipeline_runs SET status = ?, report = ?, error = ?, finished_at = ? WHERE id = ?')
    .bind(status, JSON.stringify(report), error, now(), runId)
    .run();
}

export const RETRY_CRON = '30 20 * * *';

/**
 * The backup trigger an hour after the daily one: it runs again only when the day's issue
 * has no draft yet and its last run failed (or never started). One retry a day at most.
 */
export async function retryIfFailed(env: Env, at: Date): Promise<void> {
  await ensureSchema(env.DB);
  const issueDate = issueDateFor(at);
  if (await env.DB.prepare('SELECT 1 FROM issues WHERE date = ?').bind(issueDate).first()) return;
  const last = await env.DB.prepare('SELECT status FROM pipeline_runs WHERE issue_date = ? ORDER BY started_at DESC LIMIT 1')
    .bind(issueDate)
    .first<{ status: string }>();
  if (last && last.status !== 'failed') return;
  await runPipeline(env, { trigger: 'retry', at });
}

export async function runPipeline(env: Env, options: { trigger: 'cron' | 'retry' | 'manual'; at?: Date; issueDate?: string }): Promise<{ runId: string; status: 'drafted' | 'failed'; report: RunReport }> {
  await ensureSchema(env.DB);
  const at = options.at ?? new Date();
  const started = Date.now();
  const issueDate = options.issueDate ?? issueDateFor(at);
  const window = windowFor(issueDate, at);
  const attempt = await env.DB.prepare('SELECT COUNT(*) AS n FROM pipeline_runs WHERE issue_date = ?').bind(issueDate).first<{ n: number }>();
  const runId = `${issueDate}-${(attempt?.n ?? 0) + 1}`;
  await env.DB.prepare("INSERT INTO pipeline_runs (id, issue_date, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)")
    .bind(runId, issueDate, options.trigger, now())
    .run();

  const report: RunReport = {
    issueDate,
    agent: null,
    reviewer: null,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    feeds: [],
    candidates: 0,
    picked: 0,
    sourcesFetched: 0,
    sourceFailures: [],
    genericImages: 0,
    checks: [],
    review: null,
    translationWarnings: [],
    stories: 0,
    briefs: 0,
    saved: null,
    durationMs: 0,
    step: 'starting',
  };

  try {
    // Both agents are settled before the first billed turn.
    const agentId = await writerAgentId(env);
    if (!agentId) throw new Error('No writer agent is set. Choose one in /admin under Issues.');
    const reviewerId = await reviewerAgentId(env);
    if (!reviewerId) throw new Error('No review agent is set. Choose one in /admin under Issues; it must be a different agent from the writer.');
    const cred = await credentialFor(env, agentId);
    const reviewerCred = await credentialFor(env, reviewerId);
    report.agent = cred.label;
    report.reviewer = reviewerCred.label;

    // 1. Collect candidates from the feeds.
    report.step = 'collecting';
    const collected = await collectCandidates(window);
    report.feeds = collected.feeds;
    // Feed windows overlap by design, so drop what the last week already ran before picking.
    const covered = await recentCoverage(env, issueDate);
    const candidates = collected.candidates.filter((c) => !covered.urls.has(c.link));
    report.candidates = candidates.length;
    if (candidates.length === 0) throw new Error('No candidate stories in the window.');

    // 2. The agent picks (billed turn 1).
    report.step = 'picking';
    const picked = extractJson(await agentTurn(cred, `aiin5-${runId}-pick`, selectPrompt(issueDate, candidates, covered.headlines))) as { items?: unknown[] };
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const items = (Array.isArray(picked.items) ? picked.items : [])
      .slice(0, 10)
      .map((raw) => {
        const item = (raw ?? {}) as { type?: unknown; candidates?: unknown; extraUrls?: unknown };
        const chosen = (Array.isArray(item.candidates) ? item.candidates : []).map((id) => byId.get(String(id))).filter((c): c is Candidate => Boolean(c));
        const extra = (Array.isArray(item.extraUrls) ? item.extraUrls : []).filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 2);
        return { type: item.type === 'brief' ? ('brief' as const) : ('story' as const), urls: itemUrls(chosen, extra) };
      })
      .filter((item) => item.urls.length > 0);
    report.picked = items.length;
    if (items.length === 0) throw new Error('The agent picked nothing usable.');

    // 3. Fetch every source we will hand to the writer.
    report.step = 'fetching sources';
    const urls = items.flatMap((item) => item.urls).slice(0, MAX_SOURCE_FETCHES);
    const { snapshots, failures } = await fetchSnapshots(env, urls);
    report.sourcesFetched = snapshots.size;
    report.sourceFailures = failures;
    // Logos and site-default share images are not news pictures: forget them before writing.
    const generic = await genericImages(env, [...snapshots.values()], NO_IMAGE_HOSTS);
    report.genericImages = generic.size;
    snapshots.forEach((snap, url) => {
      if (snap.image && generic.has(snap.image)) snapshots.set(url, { ...snap, image: null });
    });
    const candidateByUrl = new Map(candidates.map((c) => [c.link, c]));
    const writeItems: WriteItem[] = items
      .map((item) => ({
        type: item.type,
        sources: item.urls
          .map((url): WriteItem['sources'][number] | null => {
            const snapshot = snapshots.get(url);
            const c = candidateByUrl.get(url);
            if (!snapshot || snapshot.text.length < 200) return null;
            const { name, kind } = c ? { name: c.sourceName.en, kind: c.kind } : extraSource(url);
            return { url, name, kind, lang: c?.lang ?? 'en', published: c?.published ?? null, snapshot };
          })
          .filter((s): s is WriteItem['sources'][number] => s !== null),
      }))
      .filter((item) => item.sources.length > 0);
    if (writeItems.length === 0) throw new Error('None of the picked sources could be read.');

    // 4. The agent writes the English master (billed turn 2).
    report.step = 'writing';
    const official = new Set(writeItems.flatMap((item) => item.sources.filter((s) => s.kind === 'official').map((s) => s.url)));
    const draft = pinOfficial(readDraft(extractJson(await agentTurn(cred, `aiin5-${runId}-write`, writePrompt(issueDate, writeItems)))), official);

    // 5. Check 1: code checks every quote and number against the fetched texts.
    report.step = 'checking';
    const texts = new Map<string, Snapshot>();
    snapshots.forEach((s, url) => texts.set(url, s));
    const checked = checkDraft(draft, texts, covered.urls);
    report.checks = checked.checks;
    if (checked.draft.stories.length < MIN_STORIES) throw new Error(`Only ${checked.draft.stories.length} stories passed the checks; at least ${MIN_STORIES} are needed.`);

    // 6. Check 2: the review agent judges the checked draft against the sources (billed
    // turn 3, on the reviewer); its fixes go through check 1 again.
    report.step = 'reviewing';
    const verdicts = readReview(extractJson(await agentTurn(reviewerCred, `aiin5-${runId}-review`, reviewPrompt(issueDate, checked.draft, texts, covered.headlines))));
    const reviewed = applyReview(checked.draft, verdicts, texts, reviewerCred.label);
    report.review = reviewed.review;
    if (reviewed.draft.stories.length < MIN_STORIES) throw new Error(`Only ${reviewed.draft.stories.length} stories passed the review; at least ${MIN_STORIES} are needed.`);

    // 7. The writer translates (billed turn 4); check 3 runs while assembling.
    report.step = 'translating';
    const sourceNamesZh = new Map(candidates.map((c) => [c.link, c.sourceName.zh]));
    const entries = translationEntries(reviewed.draft, sourceNamesZh);
    const zh = extractJson(await agentTurn(cred, `aiin5-${runId}-translate`, translatePrompt(entries))) as Record<string, string>;
    const images = new Map<string, string>();
    snapshots.forEach((s, url) => s.image && images.set(url, s.image));
    const { issue, warnings } = assembleIssue({ date: issueDate, number: await nextNumber(env, issueDate), draft: reviewed.draft, zh, sourceNamesZh, images });
    report.translationWarnings = warnings;

    // 8. Save as a draft. Never published from here.
    report.step = 'saving';
    validateIssue(issue);
    const existing = await env.DB.prepare('SELECT status FROM issues WHERE date = ?').bind(issueDate).first<{ status: string }>();
    if (existing?.status === 'published') throw new Error('An issue for this date is already published; the draft was not saved over it.');
    await saveIssue(env, issueDate, issue, 'draft');
    report.saved = 'draft';
    report.stories = issue.stories.length;
    report.briefs = issue.briefs.length;
    report.step = 'done';
    report.durationMs = Date.now() - started;
    await finish(env, runId, 'drafted', report, null);
    return { runId, status: 'drafted', report };
  } catch (error) {
    report.durationMs = Date.now() - started;
    const message = safeErrorText(error instanceof Error ? error.message : error);
    console.error('pipeline run failed', runId, report.step, message);
    await finish(env, runId, 'failed', report, message);
    return { runId, status: 'failed', report };
  }
}

/** No agent, no billing: collect candidates and read a few sources, to check the plumbing. */
export async function checkSources(env: Env, at = new Date()): Promise<{
  window: { from: string; to: string };
  feeds: FeedResult[];
  candidates: { id: string; feed: string; title: string; published: string }[];
  sources: { url: string; title: string; characters: number; image: boolean }[];
  failures: { url: string; error: string }[];
}> {
  await ensureSchema(env.DB);
  const window = windowFor(issueDateFor(at), at);
  const { candidates, feeds } = await collectCandidates(window);
  const sample = candidates.slice(0, 6).map((c) => c.link);
  const { snapshots, failures } = await fetchSnapshots(env, sample);
  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    feeds,
    candidates: candidates.map((c) => ({ id: c.id, feed: c.feed, title: c.title, published: c.published })),
    sources: [...snapshots.values()].map((snap) => ({ url: snap.url, title: snap.title, characters: snap.text.length, image: Boolean(snap.image) })),
    failures,
  };
}

export async function listRuns(env: Env): Promise<{ id: string; issueDate: string; trigger: string; status: string; error: string | null; startedAt: string; finishedAt: string | null; stories: number; briefs: number }[]> {
  const { results } = await env.DB.prepare('SELECT id, issue_date, trigger, status, error, started_at, finished_at, report FROM pipeline_runs ORDER BY started_at DESC LIMIT 30').all<{
    id: string;
    issue_date: string;
    trigger: string;
    status: string;
    error: string | null;
    started_at: string;
    finished_at: string | null;
    report: string;
  }>();
  return results.map((r) => {
    const report = JSON.parse(r.report || '{}') as Partial<RunReport>;
    return { id: r.id, issueDate: r.issue_date, trigger: r.trigger, status: r.status, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at, stories: report.stories ?? 0, briefs: report.briefs ?? 0 };
  });
}

export async function getRun(env: Env, id: string): Promise<{ id: string; status: string; error: string | null; report: RunReport | null } | null> {
  const row = await env.DB.prepare('SELECT id, status, error, report FROM pipeline_runs WHERE id = ?').bind(id).first<{ id: string; status: string; error: string | null; report: string }>();
  if (!row) return null;
  return { id: row.id, status: row.status, error: row.error, report: row.report && row.report !== '{}' ? (JSON.parse(row.report) as RunReport) : null };
}
