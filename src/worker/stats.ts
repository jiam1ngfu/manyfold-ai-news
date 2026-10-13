/**
 * What the owner sees in /admin#stats: per-issue reading counts, and the two reader
 * measures of the launch gate (docs/product-plan.md §11):
 *   - "want it": the share of confirmed subscribers who opened at least 3 of the last 5
 *     issues without being reminded (an issue opened from its own email counts too);
 *   - "can't do without it": the share of survey answers that say "very disappointed".
 * Counts only: no address, and no per-person row, ever leaves the database.
 */

import type { Env } from './types';

export const GATE_SHARE = 0.4;

export interface IssueStats {
  date: string;
  number: number;
  views: { web: number; email: number };
  finishes: number;
  shares: number;
  useful: number;
  notUseful: number;
  reports: number;
}

export async function statsOverview(env: Env): Promise<{
  issues: IssueStats[];
  engagement: { subscribers: number; lastIssues: string[]; regular: number; share: number | null; target: number };
  survey: { very: number; somewhat: number; not: number; share: number | null; target: number };
}> {
  const { results: published } = await env.DB.prepare("SELECT date, number FROM issues WHERE status = 'published' ORDER BY date DESC LIMIT 14").all<{ date: string; number: number }>();
  const dates = published.map((p) => p.date);
  const marks = dates.map(() => '?').join(', ');
  const [events, feedback, reports] = dates.length
    ? await Promise.all([
        env.DB.prepare(`SELECT issue_date, event, source, SUM(n) AS n FROM daily_events WHERE issue_date IN (${marks}) GROUP BY issue_date, event, source`)
          .bind(...dates)
          .all<{ issue_date: string; event: string; source: string; n: number }>(),
        env.DB.prepare(`SELECT issue_date, value, COUNT(*) AS n FROM feedback WHERE issue_date IN (${marks}) GROUP BY issue_date, value`)
          .bind(...dates)
          .all<{ issue_date: string; value: string; n: number }>(),
        env.DB.prepare(`SELECT issue_date, COUNT(*) AS n FROM reports WHERE issue_date IN (${marks}) GROUP BY issue_date`)
          .bind(...dates)
          .all<{ issue_date: string; n: number }>(),
      ])
    : [{ results: [] }, { results: [] }, { results: [] }];
  const issues = published.map((p): IssueStats => {
    const ev = (event: string, source?: string) =>
      events.results.filter((e) => e.issue_date === p.date && e.event === event && (!source || e.source === source)).reduce((n, e) => n + e.n, 0);
    const fb = (value: string) => feedback.results.find((f) => f.issue_date === p.date && f.value === value)?.n ?? 0;
    return {
      date: p.date,
      number: p.number,
      views: { web: ev('view', 'web'), email: ev('view', 'email') },
      finishes: ev('finish'),
      shares: ev('share'),
      useful: fb('useful'),
      notUseful: fb('not_useful'),
      reports: reports.results.find((r) => r.issue_date === p.date)?.n ?? 0,
    };
  });

  const lastIssues = dates.slice(0, 5);
  const subscribers = (await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'confirmed'").first<{ n: number }>())?.n ?? 0;
  const regular = lastIssues.length
    ? ((
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT asker FROM reads WHERE issue_date IN (${lastIssues.map(() => '?').join(', ')}) GROUP BY asker HAVING COUNT(*) >= 3)`)
          .bind(...lastIssues)
          .first<{ n: number }>()
      )?.n ?? 0)
    : 0;

  const { results: answers } = await env.DB.prepare('SELECT answer, COUNT(*) AS n FROM survey GROUP BY answer').all<{ answer: string; n: number }>();
  const count = (a: string) => answers.find((r) => r.answer === a)?.n ?? 0;
  const total = count('very') + count('somewhat') + count('not');

  return {
    issues,
    engagement: { subscribers, lastIssues, regular, share: subscribers > 0 && lastIssues.length === 5 ? regular / subscribers : null, target: GATE_SHARE },
    survey: { very: count('very'), somewhat: count('somewhat'), not: count('not'), share: total > 0 ? count('very') / total : null, target: GATE_SHARE },
  };
}
