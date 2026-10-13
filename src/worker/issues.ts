/**
 * Daily issues in D1: the public read side (published only) and the admin write side.
 * Issue JSON is validated before it is stored, so reads can trust its shape.
 */

import type { Issue, IssueResponse, IssueSummary } from '../shared/issue';
import { validateIssue } from '../shared/issue';
import { HttpError, type Env } from './types';
import { now } from './db';
import { SAMPLE_ISSUE } from './sample-issue';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDate(value: string, label = 'date'): string {
  if (!DATE.test(value)) throw new HttpError(400, 'bad_request', `${label} must be YYYY-MM-DD.`);
  return value;
}

interface IssueRow {
  date: string;
  data: string;
}

async function neighbours(env: Env, date: string): Promise<{ prev: string | null; next: string | null }> {
  const [prev, next] = await Promise.all([
    env.DB.prepare("SELECT MAX(date) AS d FROM issues WHERE status = 'published' AND date < ?").bind(date).first<{ d: string | null }>(),
    env.DB.prepare("SELECT MIN(date) AS d FROM issues WHERE status = 'published' AND date > ?").bind(date).first<{ d: string | null }>(),
  ]);
  return { prev: prev?.d ?? null, next: next?.d ?? null };
}

async function respond(env: Env, row: IssueRow | null): Promise<IssueResponse> {
  if (!row) return { issue: null, prev: null, next: null };
  return { issue: JSON.parse(row.data) as Issue, ...(await neighbours(env, row.date)) };
}

/** The newest published issue dated on or before `before` (the reader's local date). */
export async function getLatestIssue(env: Env, before: string | null): Promise<IssueResponse> {
  const row = before
    ? await env.DB.prepare("SELECT date, data FROM issues WHERE status = 'published' AND date <= ? ORDER BY date DESC LIMIT 1")
        .bind(assertDate(before, 'before'))
        .first<IssueRow>()
    : await env.DB.prepare("SELECT date, data FROM issues WHERE status = 'published' ORDER BY date DESC LIMIT 1").first<IssueRow>();
  return respond(env, row);
}

export async function getIssue(env: Env, date: string): Promise<IssueResponse> {
  const row = await env.DB.prepare("SELECT date, data FROM issues WHERE status = 'published' AND date = ?")
    .bind(assertDate(date))
    .first<IssueRow>();
  if (!row) throw new HttpError(404, 'issue_not_found', 'There is no published issue for that date.');
  return respond(env, row);
}

export async function listIssues(env: Env, limit = 60): Promise<IssueSummary[]> {
  const { results } = await env.DB.prepare(
    "SELECT date, number, data FROM issues WHERE status = 'published' ORDER BY date DESC LIMIT ?",
  )
    .bind(Math.min(Math.max(limit, 1), 200))
    .all<{ date: string; number: number; data: string }>();
  return results.map((r) => {
    const issue = JSON.parse(r.data) as Issue;
    return { date: r.date, number: r.number, headline: issue.today[0]?.text ?? issue.stories[0]?.title ?? issue.briefs[0].text };
  });
}

/* ───────── admin ───────── */

export type IssueStatus = 'draft' | 'published';

export async function listAllIssues(env: Env): Promise<{ date: string; number: number; status: string; updatedAt: string }[]> {
  const { results } = await env.DB.prepare('SELECT date, number, status, updated_at FROM issues ORDER BY date DESC LIMIT 200').all<{
    date: string;
    number: number;
    status: string;
    updated_at: string;
  }>();
  return results.map((r) => ({ date: r.date, number: r.number, status: r.status, updatedAt: r.updated_at }));
}

export async function saveIssue(env: Env, date: string, raw: unknown, status: IssueStatus): Promise<Issue> {
  const issue = validateIssue(raw);
  if (issue.date !== assertDate(date)) throw new HttpError(400, 'bad_request', 'The issue date must match the URL.');
  const at = now();
  await env.DB.prepare(
    `INSERT INTO issues (date, number, status, data, published_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (date) DO UPDATE SET number = excluded.number, status = excluded.status, data = excluded.data,
       published_at = COALESCE(issues.published_at, excluded.published_at), updated_at = excluded.updated_at`,
  )
    .bind(issue.date, issue.number, status, JSON.stringify(issue), status === 'published' ? at : null, at)
    .run();
  return issue;
}

/** Any issue, draft or published, for the owner's preview. */
export async function getAnyIssue(env: Env, date: string): Promise<{ issue: Issue; status: string } & IssueResponse> {
  const row = await env.DB.prepare('SELECT date, status, data FROM issues WHERE date = ?').bind(assertDate(date)).first<IssueRow & { status: string }>();
  if (!row) throw new HttpError(404, 'issue_not_found', 'There is no issue for that date.');
  const response = await respond(env, row);
  return { ...response, issue: response.issue!, status: row.status };
}

export async function setIssueStatus(env: Env, date: string, status: IssueStatus): Promise<void> {
  const at = now();
  const result = await env.DB.prepare(
    `UPDATE issues SET status = ?, updated_at = ?,
       published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END
     WHERE date = ?`,
  )
    .bind(status, at, status, at, assertDate(date))
    .run();
  if (!result.meta.changes) throw new HttpError(404, 'issue_not_found', 'There is no issue for that date.');
}

/* ───────── local development ───────── */

let seeded: Promise<void> | null = null;

/**
 * In `npm run dev` only, put the fictional sample issue into an empty local database so
 * the reader has something to show. Production builds never run this: the live site
 * stays empty until a real issue is published.
 */
export function seedSampleIssue(env: Env): Promise<void> {
  if (import.meta.env?.DEV !== true) return Promise.resolve();
  if (!seeded) {
    seeded = (async () => {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM issues').first<{ n: number }>();
      if ((row?.n ?? 0) === 0) await saveIssue(env, SAMPLE_ISSUE.date, SAMPLE_ISSUE, 'published');
    })().catch((error) => {
      seeded = null;
      throw error;
    });
  }
  return seeded;
}
