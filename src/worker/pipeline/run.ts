/**
 * The daily pipeline: collect → pick (writer) → fetch sources → write (writer) →
 * check 1 (code) → check 2 (review agent, then check 1 again) → translate (writer) →
 * check 3 (code) → publish, or save as a draft when the owner has turned
 * auto-publish off in /admin.
 *
 * Only an issue that passed all three checks is ever saved, so publishing it needs no
 * person: the owner is told by email (alerts.ts) and can correct, withdraw a story or
 * unpublish from /admin afterwards.
 *
 * Each run is one row in pipeline_runs; its id seeds the A2A messageIds, so retrying a
 * step of the same run cannot bill twice, and a cron that fires twice opens one row
 * (claimRun). Four agent turns per run, all billed: three on the writer, one on the
 * reviewer, which must be a different agent. A date that is already published is never
 * run again: corrections go through /admin, not a new run. A step whose
 * reply is not valid JSON gets one more turn to fix it (agent.ts jsonTurn). Manual runs
 * are capped per 24 hours (runBudget).
 */

import { HttpError, type Env } from '../types';
import { ensureSchema, getSetting, now, setSetting } from '../db';
import { listConnectedAgents, credentialFor } from '../connect';
import { safeErrorText } from '../a2a';
import { saveIssue } from '../issues';
import { MAX_BRIEFS, validateIssue, type SourceKind } from '../../shared/issue';
import { NO_IMAGE_HOSTS, collectCandidates, isMediaUrl, type Candidate, type FeedResult } from './feeds';
import { orgForUrl } from './orgs';
import { fetchSnapshots, genericImages, type Snapshot } from './snapshot';
import { reviewPrompt, selectPrompt, translatePrompt, writePrompt, type WriteItem } from './prompts';
import { jsonTurn } from './agent';
import { readDraft } from './draft';
import { checkDraft, pinOfficial, type ItemCheck } from './checks';
import { assembleIssue, translationEntries } from './assemble';
import { applyReview, readReview, type ReviewReport } from './review';
import { adminUrl, sendAlert } from '../alerts';

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
  /** Steps whose reply needed the extra turn to fix its JSON. */
  repairs: string[];
  stories: number;
  briefs: number;
  saved: 'draft' | 'published' | null;
  durationMs: number;
  step: string;
}

export type RunStatus = 'published' | 'drafted' | 'failed';

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

const AUTO_PUBLISH_KEY = 'pipeline_auto_publish';
const RUN_LIMIT_KEY = 'pipeline_run_limit';
export const DEFAULT_RUN_LIMIT = 4;

/** On unless the owner turned it off: an issue that passed every check goes straight out. */
export const autoPublish = async (env: Env): Promise<boolean> => (await getSetting(env, AUTO_PUBLISH_KEY)) !== 'off';

/** Runs of any kind in the last 24 hours, and how many the owner allows. */
export async function runBudget(env: Env): Promise<{ used: number; limit: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM pipeline_runs WHERE started_at > ?').bind(since).first<{ n: number }>();
  const limit = Number(await getSetting(env, RUN_LIMIT_KEY));
  return { used: row?.n ?? 0, limit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_RUN_LIMIT };
}

/** A manual run bills four turns, so it waits when the day's budget is spent. The cron never does. */
export async function assertRunBudget(env: Env): Promise<void> {
  const { used, limit } = await runBudget(env);
  if (used >= limit) throw new HttpError(429, 'run_limit', `${used} runs in the last 24 hours, and the limit is ${limit}. Raise it under Automation if you need another run.`);
}

export async function setPipelineSettings(env: Env, body: Record<string, unknown> | null): Promise<void> {
  if (typeof body?.autoPublish === 'boolean') await setSetting(env, AUTO_PUBLISH_KEY, body.autoPublish ? 'on' : 'off');
  if (body?.runLimit !== undefined) {
    const limit = Number(body.runLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new HttpError(400, 'bad_request', 'The run limit must be a whole number from 1 to 20.');
    await setSetting(env, RUN_LIMIT_KEY, String(limit));
  }
}

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

async function finish(env: Env, runId: string, status: RunStatus, report: RunReport, error: string | null): Promise<void> {
  await env.DB.prepare('UPDATE pipeline_runs SET status = ?, report = ?, error = ?, finished_at = ? WHERE id = ?')
    .bind(status, JSON.stringify(report), error, now(), runId)
    .run();
}

export const RETRY_CRON = '30 20 * * *';

export type RunTrigger = 'cron' | 'retry' | 'manual';

/**
 * Opens a run's row and returns its id, `${issueDate}-${n}` for the date's n-th run.
 * Cloudflare can fire a cron twice a few seconds apart, and every run bills four agent
 * turns, so a scheduled trigger (cron or retry) runs once per issue date: the count and
 * the claim are one statement, two invocations racing cannot both insert, and the later
 * one gets null. Manual runs from /admin always open a new row.
 */
export async function claimRun(env: Env, issueDate: string, trigger: RunTrigger): Promise<string | null> {
  const row = await env.DB.prepare(
    `INSERT INTO pipeline_runs (id, issue_date, trigger, status, started_at)
     SELECT ? || '-' || (n + 1), ?, ?, 'running', ? FROM (SELECT COUNT(*) AS n FROM pipeline_runs WHERE issue_date = ?)
     WHERE ? = 'manual' OR NOT EXISTS (SELECT 1 FROM pipeline_runs WHERE issue_date = ? AND trigger = ?)
     RETURNING id`,
  )
    .bind(issueDate, issueDate, trigger, now(), issueDate, trigger, issueDate, trigger)
    .first<{ id: string }>();
  return row?.id ?? null;
}

const isPublished = async (env: Env, issueDate: string): Promise<boolean> =>
  Boolean(await env.DB.prepare("SELECT 1 AS ok FROM issues WHERE date = ? AND status = 'published'").bind(issueDate).first());

/**
 * The backup trigger an hour after the daily one: it runs again only when the day's issue
 * has no draft yet and its last run failed (or never started). One retry a day at most,
 * which claimRun enforces even if this cron fires twice.
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

/**
 * Null when nothing was done or billed: a scheduled trigger already ran for this issue
 * date, or the date is already published. A manual run on a published date is refused
 * (409) before any agent is called.
 */
export async function runPipeline(env: Env, options: { trigger: RunTrigger; at?: Date; issueDate?: string }): Promise<{ runId: string; status: RunStatus; report: RunReport } | null> {
  await ensureSchema(env.DB);
  const at = options.at ?? new Date();
  const started = Date.now();
  const issueDate = options.issueDate ?? issueDateFor(at);
  const window = windowFor(issueDate, at);
  if (await isPublished(env, issueDate)) {
    if (options.trigger === 'manual') {
      throw new HttpError(409, 'already_published', `The ${issueDate} issue is already published. Correct or withdraw a story under Quality, or unpublish it first to run again.`);
    }
    console.log('pipeline run skipped: already published', issueDate, options.trigger);
    return null;
  }
  const runId = await claimRun(env, issueDate, options.trigger);
  if (!runId) {
    console.log('pipeline run skipped: already ran', issueDate, options.trigger);
    return null;
  }

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
    repairs: [],
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
    const repaired = (step: string) => () => report.repairs.push(step);
    const picked = (await jsonTurn(cred, `aiin5-${runId}-pick`, selectPrompt(issueDate, candidates, covered.headlines), repaired('pick'))) as { items?: unknown[] };
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
    const draft = pinOfficial(readDraft(await jsonTurn(cred, `aiin5-${runId}-write`, writePrompt(issueDate, writeItems), repaired('write'))), official);

    // 5. Check 1: code checks every quote and number against the fetched texts.
    report.step = 'checking';
    const texts = new Map<string, Snapshot>();
    snapshots.forEach((s, url) => texts.set(url, s));
    const checked = checkDraft(draft, texts, covered.urls);
    report.checks = checked.checks;
    // No minimum: whatever passes makes the issue, however short. Only an empty one stops here.
    if (checked.draft.stories.length + checked.draft.briefs.length === 0) throw new Error('Nothing passed the checks.');

    // 6. Check 2: the review agent judges the checked draft against the sources (billed
    // turn 3, on the reviewer); its fixes go through check 1 again.
    report.step = 'reviewing';
    const verdicts = readReview(await jsonTurn(reviewerCred, `aiin5-${runId}-review`, reviewPrompt(issueDate, checked.draft, texts, covered.headlines), repaired('review')));
    const reviewed = applyReview(checked.draft, verdicts, texts, reviewerCred.label);
    report.review = reviewed.review;
    if (reviewed.draft.stories.length + reviewed.draft.briefs.length === 0) throw new Error('Nothing passed the review.');
    // More briefs than an issue holds: keep the picker's first ones rather than fail the run.
    const final = { ...reviewed.draft, briefs: reviewed.draft.briefs.slice(0, MAX_BRIEFS) };

    // 7. The writer translates (billed turn 4); check 3 runs while assembling.
    report.step = 'translating';
    const sourceNamesZh = new Map(candidates.map((c) => [c.link, c.sourceName.zh]));
    const entries = translationEntries(final, sourceNamesZh);
    const zh = (await jsonTurn(cred, `aiin5-${runId}-translate`, translatePrompt(entries), repaired('translate'))) as Record<string, string>;
    const images = new Map<string, string>();
    snapshots.forEach((s, url) => s.image && images.set(url, s.image));
    const { issue, warnings } = assembleIssue({ date: issueDate, number: await nextNumber(env, issueDate), draft: final, zh, sourceNamesZh, images });
    report.translationWarnings = warnings;

    // 8. Publish, or save a draft when the owner turned auto-publish off. A published
    // issue is never overwritten: corrections to it go through /admin.
    report.step = 'saving';
    validateIssue(issue);
    const existing = await env.DB.prepare('SELECT status FROM issues WHERE date = ?').bind(issueDate).first<{ status: string }>();
    if (existing?.status === 'published') throw new Error('An issue for this date is already published; the new one was not saved over it.');
    const status = (await autoPublish(env)) ? 'published' : 'draft';
    await saveIssue(env, issueDate, issue, status);
    report.saved = status;
    report.stories = issue.stories.length;
    report.briefs = issue.briefs.length;
    report.step = 'done';
    report.durationMs = Date.now() - started;
    const runStatus: RunStatus = status === 'published' ? 'published' : 'drafted';
    await finish(env, runId, runStatus, report, null);
    if (options.trigger !== 'manual') await sendAlert(env, runAlert(env, runId, issueDate, runStatus, report, null, options.trigger));
    return { runId, status: runStatus, report };
  } catch (error) {
    report.durationMs = Date.now() - started;
    const message = safeErrorText(error instanceof Error ? error.message : error);
    console.error('pipeline run failed', runId, report.step, message);
    await finish(env, runId, 'failed', report, message);
    if (options.trigger !== 'manual') await sendAlert(env, runAlert(env, runId, issueDate, 'failed', report, message, options.trigger));
    return { runId, status: 'failed', report };
  }
}

/** Fewer items than this and the owner hears that the day was thin. */
const THIN = 3;

/** What the owner is told after a scheduled run. Manual runs are watched in /admin. */
export function runAlert(env: Env, runId: string, issueDate: string, status: RunStatus, report: RunReport, error: string | null, trigger: RunTrigger) {
  const items = report.stories + report.briefs;
  const cut = report.checks.filter((c) => !c.kept).length + (report.review?.items.filter((i) => !i.kept).length ?? 0);
  const site = (env.SITE_URL ?? '').replace(/\/+$/, '');
  if (status === 'failed') {
    return {
      key: `failed:${runId}`,
      subject: `${issueDate}: the ${trigger === 'retry' ? 'retry' : 'daily run'} failed`,
      lines: [
        `The run for ${issueDate} stopped while ${report.step}: ${error ?? 'unknown error'}`,
        trigger === 'retry'
          ? 'This was the one automatic retry, so there is no issue for that date unless you run the pipeline by hand. Run it before 23:00 UTC to reach readers in Asia at 7:00.'
          : 'It retries once at 20:30 UTC. You will hear again only if that fails too.',
      ],
      link: { label: 'Open the run report', url: adminUrl(env, 'issues') },
    };
  }
  const lines = [
    `${items} ${items === 1 ? 'item' : 'items'} (${report.stories} stories, ${report.briefs} briefs). ${cut} cut by the checks.`,
    ...(items < THIN ? [`A thin day: fewer than ${THIN} items passed the checks. That is by design (a shorter issue beats a wrong one), but check that the feeds are healthy.`] : []),
    ...(report.repairs.length ? [`The agent's JSON needed a repair turn at: ${report.repairs.join(', ')}.`] : []),
    status === 'published'
      ? 'It is live and goes to subscribers at 7:00 their time. To fix a story, withdraw one or unpublish the issue, use /admin.'
      : 'Auto-publish is off, so it is waiting as a draft. Publish it before 23:00 UTC to reach readers in Asia at 7:00.',
  ];
  return {
    key: `${status}:${issueDate}`,
    subject: `${issueDate}: ${status === 'published' ? 'published' : 'draft ready'}, ${items} ${items === 1 ? 'item' : 'items'}`,
    lines,
    link: status === 'published' && site ? { label: 'Read it', url: `${site}/en/${issueDate}` } : { label: 'Open /admin', url: adminUrl(env, 'issues') },
  };
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

export async function listRuns(env: Env): Promise<{ id: string; issueDate: string; trigger: string; status: string; error: string | null; startedAt: string; finishedAt: string | null; stories: number; briefs: number; repairs: number }[]> {
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
    return { id: r.id, issueDate: r.issue_date, trigger: r.trigger, status: r.status, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at, stories: report.stories ?? 0, briefs: report.briefs ?? 0, repairs: report.repairs?.length ?? 0 };
  });
}

export async function getRun(env: Env, id: string): Promise<{ id: string; status: string; error: string | null; report: RunReport | null } | null> {
  const row = await env.DB.prepare('SELECT id, status, error, report FROM pipeline_runs WHERE id = ?').bind(id).first<{ id: string; status: string; error: string | null; report: string }>();
  if (!row) return null;
  return { id: row.id, status: row.status, error: row.error, report: row.report && row.report !== '{}' ? (JSON.parse(row.report) as RunReport) : null };
}
