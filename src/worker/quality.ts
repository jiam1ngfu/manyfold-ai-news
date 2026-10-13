/**
 * Keeping published issues right: corrections and withdrawals, readers' reports, and the
 * owner's own checks, which add up to the launch gate (docs/product-plan.md §11: five
 * issues in a row with no factual error).
 *
 * A correction rewrites the stored issue (validated like any other) and is shown to
 * readers on the story and in the public corrections log. It also counts against the
 * gate: an issue that needed a correction had an error, whatever the owner's check said.
 */

import { applyCorrection, storyPosition, type CorrectionEntry, type CorrectionRequest, type Issue, type L10n } from '../shared/issue';
import { HttpError, type Env } from './types';
import { now } from './db';
import { assertDate } from './issues';

export const GATE_NEEDED = 5;

export type Verdict = 'clean' | 'errors';

/* ───────── corrections ───────── */

export async function correctIssue(env: Env, date: string, body: Record<string, unknown> | null): Promise<Issue> {
  const row = await env.DB.prepare("SELECT data FROM issues WHERE date = ? AND status = 'published'").bind(assertDate(date)).first<{ data: string }>();
  if (!row) throw new HttpError(404, 'issue_not_found', 'Only a published issue can be corrected. Edit a draft by running the pipeline again.');
  const request: CorrectionRequest = {
    kind: body?.kind === 'withdrawn' ? 'withdrawn' : 'corrected',
    target: typeof body?.target === 'string' ? body.target : '',
    note: body?.note as L10n,
    fix: (body?.fix ?? undefined) as CorrectionRequest['fix'],
  };
  const issue = applyCorrection(JSON.parse(row.data) as Issue, request, now());
  const storyId = request.target.startsWith('brief-') ? null : request.target;
  const at = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE issues SET data = ?, updated_at = ? WHERE date = ?').bind(JSON.stringify(issue), at, date),
    env.DB.prepare(
      `INSERT INTO issue_checks (issue_date, verdict, note, checked_at) VALUES (?, 'errors', ?, ?)
       ON CONFLICT (issue_date) DO UPDATE SET verdict = 'errors', note = excluded.note, checked_at = excluded.checked_at`,
    ).bind(date, `${request.kind === 'withdrawn' ? 'Withdrew' : 'Corrected'} ${request.target}.`, at),
    // The reports on that story are answered by the correction.
    env.DB.prepare("UPDATE reports SET status = 'resolved' WHERE issue_date = ? AND story_id = ? AND status = 'open'").bind(date, storyId ?? ''),
  ]);
  return issue;
}

/** Every correction in a published issue, newest first: the public corrections log. */
export async function listCorrections(env: Env): Promise<CorrectionEntry[]> {
  const { results } = await env.DB.prepare(
    "SELECT date, number, data FROM issues WHERE status = 'published' AND json_array_length(json_extract(data, '$.corrections')) > 0 ORDER BY date DESC LIMIT 200",
  ).all<{ date: string; number: number; data: string }>();
  const entries: CorrectionEntry[] = [];
  for (const r of results) {
    const issue = JSON.parse(r.data) as Issue;
    for (const c of issue.corrections ?? []) {
      const position = c.kind === 'corrected' && c.story ? storyPosition(issue, c.story) : 0;
      entries.push({ ...c, date: r.date, number: r.number, position: position || null });
    }
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

/* ───────── readers' reports ───────── */

export interface ReportRow {
  id: number;
  issueDate: string;
  storyId: string;
  storyTitle: string | null;
  position: number | null;
  target: string;
  lang: string;
  note: string | null;
  status: string;
  createdAt: string;
}

export async function listReports(env: Env, status: 'open' | 'resolved' | 'all' = 'open'): Promise<ReportRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.issue_date, r.story_id, r.target, r.lang, r.status, r.created_at, n.note
     FROM reports r LEFT JOIN report_notes n ON n.report_id = r.id
     ${status === 'all' ? '' : 'WHERE r.status = ?'} ORDER BY r.created_at DESC LIMIT 100`,
  )
    .bind(...(status === 'all' ? [] : [status]))
    .all<{ id: number; issue_date: string; story_id: string; target: string; lang: string; status: string; created_at: string; note: string | null }>();
  const dates = [...new Set(results.map((r) => r.issue_date))];
  const issues = new Map<string, Issue>();
  if (dates.length) {
    const rows = await env.DB.prepare(`SELECT date, data FROM issues WHERE date IN (${dates.map(() => '?').join(', ')})`)
      .bind(...dates)
      .all<{ date: string; data: string }>();
    rows.results.forEach((row) => issues.set(row.date, JSON.parse(row.data) as Issue));
  }
  return results.map((r) => {
    const issue = issues.get(r.issue_date);
    const story = issue?.stories.find((s) => s.id === r.story_id);
    return {
      id: r.id,
      issueDate: r.issue_date,
      storyId: r.story_id,
      storyTitle: story?.title.en ?? null,
      position: issue && story ? storyPosition(issue, story.id) : null,
      target: r.target,
      lang: r.lang,
      note: r.note,
      status: r.status,
      createdAt: r.created_at,
    };
  });
}

export async function setReportStatus(env: Env, id: number, status: unknown): Promise<void> {
  if (status !== 'open' && status !== 'resolved') throw new HttpError(400, 'bad_request', 'status must be open or resolved.');
  const result = await env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?').bind(status, id).run();
  if (!result.meta.changes) throw new HttpError(404, 'not_found', 'No such report.');
}

/* ───────── the owner's checks and the launch gate ───────── */

export async function setIssueCheck(env: Env, date: string, body: Record<string, unknown> | null): Promise<void> {
  const verdict = body?.verdict;
  if (verdict === null) {
    await env.DB.prepare('DELETE FROM issue_checks WHERE issue_date = ?').bind(assertDate(date)).run();
    return;
  }
  if (verdict !== 'clean' && verdict !== 'errors') throw new HttpError(400, 'bad_request', 'verdict must be clean, errors or null.');
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
  await env.DB.prepare(
    `INSERT INTO issue_checks (issue_date, verdict, note, checked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (issue_date) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, checked_at = excluded.checked_at`,
  )
    .bind(assertDate(date), verdict, note, now())
    .run();
}

export interface GateIssue {
  date: string;
  verdict: Verdict | null;
  corrected: boolean;
}

/**
 * The launch gate from the newest published issue back: issues the owner has not checked
 * yet are waiting, then clean ones count until the first issue with an error (by the
 * owner's check or because it needed a correction).
 */
export function gateStreak(issues: GateIssue[]): { streak: number; waiting: string[]; brokenBy: string | null } {
  const waiting: string[] = [];
  let streak = 0;
  let i = 0;
  while (i < issues.length && issues[i].verdict === null && !issues[i].corrected) waiting.push(issues[i++].date);
  for (; i < issues.length; i += 1) {
    const issue = issues[i];
    if (issue.corrected || issue.verdict === 'errors') return { streak, waiting, brokenBy: issue.date };
    if (issue.verdict === null) break;
    streak += 1;
  }
  return { streak, waiting, brokenBy: null };
}

export async function qualityOverview(env: Env): Promise<{
  gate: { needed: number; streak: number; waiting: string[]; brokenBy: string | null };
  issues: { date: string; number: number; items: number; verdict: Verdict | null; note: string | null; corrections: number; openReports: number }[];
  reports: ReportRow[];
  corrections: CorrectionEntry[];
}> {
  const { results } = await env.DB.prepare(
    `SELECT i.date, i.number, i.data, c.verdict, c.note,
       (SELECT COUNT(*) FROM reports r WHERE r.issue_date = i.date AND r.status = 'open') AS open_reports
     FROM issues i LEFT JOIN issue_checks c ON c.issue_date = i.date
     WHERE i.status = 'published' ORDER BY i.date DESC LIMIT 30`,
  ).all<{ date: string; number: number; data: string; verdict: Verdict | null; note: string | null; open_reports: number }>();
  const issues = results.map((r) => {
    const issue = JSON.parse(r.data) as Issue;
    return {
      date: r.date,
      number: r.number,
      items: issue.stories.length + issue.briefs.length,
      verdict: r.verdict,
      note: r.note,
      corrections: issue.corrections?.length ?? 0,
      openReports: r.open_reports,
    };
  });
  const gate = gateStreak(issues.map((i) => ({ date: i.date, verdict: i.verdict, corrected: i.corrections > 0 })));
  return {
    gate: { needed: GATE_NEEDED, ...gate },
    issues,
    reports: await listReports(env, 'open'),
    corrections: await listCorrections(env),
  };
}
