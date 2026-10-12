/**
 * Readers' own questions about a story ("Ask about this story", step 2 of appendix A in
 * docs/product-plan.md).
 *
 * Only confirmed subscribers may ask: their browser holds an ask key (a signed token from
 * the confirmation page or any link in our emails), and every question re-checks that
 * the address is still confirmed. A question is stored, then answered off the request by
 * the queue consumer, because an agent turn can outlast what a request may keep running
 * after it responds. The browser polls for the result.
 *
 * Costs are bounded three ways: a per-reader daily limit, a site-wide daily limit set in
 * /admin, and a cache that reuses the answer to the same question about the same story.
 * The owner can pause asking from /admin at any time.
 */

import type { Issue, Lang } from '../../shared/issue';
import { HttpError, type Env } from '../types';
import { getSetting, now, setSetting } from '../db';
import { safeErrorText } from '../a2a';
import { credentialFor, listConnectedAgents } from '../connect';
import { clientKey, throttle } from '../public';
import { verifyToken } from '../email/tokens';
import { agentTurn } from '../pipeline/agent';
import { extractJson } from '../pipeline/draft';
import { reviewerAgentId, writerAgentId } from '../pipeline/run';
import { NOT_COVERED, answerPrompt, normalizeQuestion, verifyAnswer, type AnswerSource } from './answer';

export interface AskMessage {
  id: string;
}

export const ANSWERER_AGENT_KEY = 'ask_answer_agent';
const ENABLED_KEY = 'ask_enabled';
const DAILY_LIMIT_KEY = 'ask_daily_limit';
export const PER_READER_PER_DAY = 10;
const DEFAULT_DAILY_LIMIT = 300;
const TURN_TIMEOUT_MS = 2 * 60 * 1000;
const PER_SOURCE_CHARS = 15_000;
const TOTAL_SOURCE_CHARS = 40_000;
const FINAL = ['answered', 'partial', 'none'];

/** The answer agent must be a third agent: never the writer or the reviewer. */
export async function answererAgentId(env: Env): Promise<string | null> {
  const chosen = await getSetting(env, ANSWERER_AGENT_KEY);
  if (!chosen || chosen === (await writerAgentId(env)) || chosen === (await reviewerAgentId(env))) return null;
  return (await listConnectedAgents(env)).some((a) => a.agentId === chosen) ? chosen : null;
}

export const setAnswererAgent = (env: Env, agentId: string) => setSetting(env, ANSWERER_AGENT_KEY, agentId);

export async function askSettings(env: Env): Promise<{ enabled: boolean; dailyLimit: number }> {
  // An unset limit is the default, not zero: Number(null) would be 0 and close asking.
  const stored = await getSetting(env, DAILY_LIMIT_KEY);
  const limit = stored === null ? NaN : Number(stored);
  return { enabled: (await getSetting(env, ENABLED_KEY)) !== '0', dailyLimit: Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_DAILY_LIMIT };
}

export async function setAskSettings(env: Env, body: Record<string, unknown> | null): Promise<void> {
  if (typeof body?.enabled === 'boolean') await setSetting(env, ENABLED_KEY, body.enabled ? '1' : '0');
  if (body?.dailyLimit !== undefined) {
    const n = Number(body.dailyLimit);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new HttpError(400, 'bad_request', 'dailyLimit must be a whole number from 0 to 10000.');
    await setSetting(env, DAILY_LIMIT_KEY, String(n));
  }
}

const startOfDay = () => `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

type Body = Record<string, unknown> | null;

export interface AskResult {
  id: string;
  status: string;
  answer?: { status: string; a: string; cites: unknown[] };
  remaining?: number;
}

const answerOf = (status: string, json: string) => ({ status, ...(JSON.parse(json) as { a: string; cites: unknown[] }) });

export async function askQuestion(env: Env, body: Body, client: string): Promise<AskResult> {
  const email = typeof body?.key === 'string' ? await verifyToken(env, body.key, 'ask') : null;
  const subscriber = email ? await env.DB.prepare('SELECT status FROM subscribers WHERE email = ?').bind(email).first<{ status: string }>() : null;
  if (!email || subscriber?.status !== 'confirmed') throw new HttpError(403, 'not_subscribed', 'Subscribe and confirm your address to ask your own questions.');

  const settings = await askSettings(env);
  if (!settings.enabled) throw new HttpError(503, 'ask_paused', 'Asking is paused for now.');
  const date = typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : '';
  const storyId = typeof body?.storyId === 'string' && /^[a-z0-9-]{1,60}$/.test(body.storyId) ? body.storyId : '';
  const lang: Lang = body?.lang === 'zh' ? 'zh' : 'en';
  const question = typeof body?.question === 'string' ? body.question.replace(/\s+/g, ' ').trim() : '';
  if (!date || !storyId) throw new HttpError(400, 'bad_request', 'date and storyId are required.');
  if (question.length < 3 || question.length > 200) throw new HttpError(400, 'bad_question', 'Ask in 3 to 200 characters.');

  const row = await env.DB.prepare("SELECT data FROM issues WHERE date = ? AND status = 'published'").bind(date).first<{ data: string }>();
  const issue = row ? (JSON.parse(row.data) as Issue) : null;
  if (!issue?.stories.some((s) => s.id === storyId)) throw new HttpError(404, 'story_not_found', 'That story is not in a published issue.');

  await throttle(env, 'ask', client, 30);
  const asker = await clientKey(env, `ask:${email}`);
  const since = startOfDay();
  const used = (await env.DB.prepare('SELECT COUNT(*) AS n FROM questions WHERE asker = ? AND created_at >= ? AND cached_from IS NULL').bind(asker, since).first<{ n: number }>())?.n ?? 0;

  const norm = normalizeQuestion(question);
  const at = now();
  const id = newId();
  // The same question about the same story: reuse the answer, at no cost and outside the limits.
  const cached = await env.DB.prepare(
    `SELECT id, status, answer FROM questions WHERE issue_date = ? AND story_id = ? AND lang = ? AND norm = ? AND status IN ('answered', 'partial', 'none') AND cached_from IS NULL ORDER BY created_at LIMIT 1`,
  )
    .bind(date, storyId, lang, norm)
    .first<{ id: string; status: string; answer: string }>();
  if (cached) {
    await env.DB.prepare(
      'INSERT INTO questions (id, issue_date, story_id, lang, question, norm, asker, status, answer, cached_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, date, storyId, lang, question, norm, asker, cached.status, cached.answer, cached.id, at, at)
      .run();
    return { id, status: cached.status, answer: answerOf(cached.status, cached.answer), remaining: Math.max(0, PER_READER_PER_DAY - used) };
  }

  // Limits apply to new questions only: a cached answer costs nothing.
  if (used >= PER_READER_PER_DAY) throw new HttpError(429, 'ask_limit', `You can ask ${PER_READER_PER_DAY} questions a day. More tomorrow.`);

  const today = (await env.DB.prepare('SELECT COUNT(*) AS n FROM questions WHERE created_at >= ? AND cached_from IS NULL').bind(since).first<{ n: number }>())?.n ?? 0;
  if (today >= settings.dailyLimit) throw new HttpError(503, 'ask_busy', 'We have answered all the questions we can today. Try again tomorrow.');
  if (!(await answererAgentId(env)) || !env.ASK_QUEUE) throw new HttpError(503, 'ask_paused', 'Asking is paused for now.');

  await env.DB.prepare('INSERT INTO questions (id, issue_date, story_id, lang, question, norm, asker, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, date, storyId, lang, question, norm, asker, 'queued', at, at)
    .run();
  await env.ASK_QUEUE.send({ id });
  return { id, status: 'queued', remaining: PER_READER_PER_DAY - used - 1 };
}

/** Polled by the browser. The id is 128 random bits, so it is its own access check. */
export async function getQuestion(env: Env, id: string): Promise<AskResult> {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(404, 'not_found', 'No such question.');
  const row = await env.DB.prepare('SELECT status, answer FROM questions WHERE id = ?').bind(id).first<{ status: string; answer: string | null }>();
  if (!row) throw new HttpError(404, 'not_found', 'No such question.');
  return { id, status: row.status, ...(row.answer && FINAL.includes(row.status) ? { answer: answerOf(row.status, row.answer) } : {}) };
}

async function finish(env: Env, id: string, status: string, answer: { a: string; cites: unknown[] } | null, dropped: number, error: string | null): Promise<void> {
  await env.DB.prepare('UPDATE questions SET status = ?, answer = ?, dropped = ?, error = ?, updated_at = ? WHERE id = ?')
    .bind(status, answer ? JSON.stringify(answer) : null, dropped, error, now(), id)
    .run();
}

/** The story's sources as the answer agent sees them: full stored text, official first. */
async function sourcesFor(env: Env, issue: Issue, storyId: string): Promise<AnswerSource[]> {
  const story = issue.stories.find((s) => s.id === storyId);
  if (!story || story.sources.length === 0) return [];
  const urls = story.sources.map((s) => s.url);
  const { results } = await env.DB.prepare(`SELECT url, text FROM source_snapshots WHERE url IN (${urls.map(() => '?').join(', ')})`)
    .bind(...urls)
    .all<{ url: string; text: string }>();
  const text = new Map(results.map((r) => [r.url, r.text]));
  let budget = TOTAL_SOURCE_CHARS;
  const out: AnswerSource[] = [];
  story.sources.forEach((s, index) => {
    const full = text.get(s.url);
    if (!full || budget <= 0) return;
    const slice = full.slice(0, Math.min(PER_SOURCE_CHARS, budget));
    budget -= slice.length;
    out.push({ index, name: s.name.en, kind: s.kind, lang: s.lang, published: s.time, text: slice });
  });
  return out;
}

/** The queue consumer's work for one question. Throws only to ask the queue for a retry. */
export async function processQuestion(env: Env, id: string, attempt: number): Promise<void> {
  const row = await env.DB.prepare('SELECT issue_date, story_id, lang, question, status FROM questions WHERE id = ?')
    .bind(id)
    .first<{ issue_date: string; story_id: string; lang: Lang; question: string; status: string }>();
  if (!row || FINAL.includes(row.status) || row.status === 'failed') return;
  await env.DB.prepare("UPDATE questions SET status = 'answering', updated_at = ? WHERE id = ?").bind(now(), id).run();
  try {
    const data = await env.DB.prepare('SELECT data FROM issues WHERE date = ?').bind(row.issue_date).first<{ data: string }>();
    const issue = data ? (JSON.parse(data.data) as Issue) : null;
    const story = issue?.stories.find((s) => s.id === row.story_id);
    if (!issue || !story) return await finish(env, id, 'failed', null, 0, 'The story is gone.');
    const sources = await sourcesFor(env, issue, row.story_id);
    // No stored source text means nothing to answer from: say so without a billed turn.
    if (sources.length === 0) return await finish(env, id, 'none', { a: NOT_COVERED[row.lang], cites: [] }, 0, null);
    const agentId = await answererAgentId(env);
    if (!agentId) return await finish(env, id, 'failed', null, 0, 'No answer agent is set.');
    const cred = await credentialFor(env, agentId);
    const reply = await agentTurn(cred, `aiin5-ask-${id}`, answerPrompt(issue, story, sources, row.question, row.lang), TURN_TIMEOUT_MS);
    const verified = verifyAnswer(extractJson(reply), sources, row.lang);
    await finish(env, id, verified.status, { a: verified.a, cites: verified.cites }, verified.dropped, null);
  } catch (error) {
    const message = safeErrorText(error instanceof Error ? error.message : error);
    if (attempt < 2) {
      await env.DB.prepare("UPDATE questions SET status = 'queued', error = ?, updated_at = ? WHERE id = ?").bind(message, now(), id).run();
      throw error;
    }
    await finish(env, id, 'failed', null, 0, message);
  }
}

/** /admin#questions: what readers ask and how often the sources cover it. No addresses. */
export async function askOverview(env: Env): Promise<{
  enabled: boolean;
  dailyLimit: number;
  perReader: number;
  answerer: string | null;
  days: { day: string; asked: number; cached: number; answered: number; partial: number; none: number; failed: number }[];
  recent: { at: string; issueDate: string; storyId: string; lang: string; question: string; status: string; dropped: number; cached: boolean; error: string | null }[];
}> {
  const settings = await askSettings(env);
  const answerer = await answererAgentId(env);
  const agents = await listConnectedAgents(env);
  const days = await env.DB.prepare(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS asked, SUM(cached_from IS NOT NULL) AS cached,
       SUM(status = 'answered') AS answered, SUM(status = 'partial') AS partial, SUM(status = 'none') AS none, SUM(status = 'failed') AS failed
     FROM questions WHERE created_at >= ? GROUP BY day ORDER BY day DESC`,
  )
    .bind(new Date(Date.now() - 14 * 86400_000).toISOString())
    .all<{ day: string; asked: number; cached: number; answered: number; partial: number; none: number; failed: number }>();
  const recent = await env.DB.prepare(
    'SELECT created_at, issue_date, story_id, lang, question, status, dropped, cached_from, error FROM questions ORDER BY created_at DESC LIMIT 40',
  ).all<{ created_at: string; issue_date: string; story_id: string; lang: string; question: string; status: string; dropped: number; cached_from: string | null; error: string | null }>();
  return {
    ...settings,
    perReader: PER_READER_PER_DAY,
    answerer: agents.find((a) => a.agentId === answerer)?.name ?? null,
    days: days.results,
    recent: recent.results.map((r) => ({
      at: r.created_at,
      issueDate: r.issue_date,
      storyId: r.story_id,
      lang: r.lang,
      question: r.question,
      status: r.status,
      dropped: r.dropped,
      cached: r.cached_from !== null,
      error: r.error,
    })),
  };
}
