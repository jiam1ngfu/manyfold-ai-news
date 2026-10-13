/**
 * /admin#stats: how the issues are read, and the two reader bars of the launch gate.
 * Counts only, as the API returns them: views (from the web, or opened from an issue
 * email), finished reads, shares, "useful" votes, reports; the share of subscribers who
 * opened 3 of the last 5 issues; and the "would you miss it" survey.
 */

import { useEffect, useState } from 'react';
import { api } from '../api';

interface IssueStats {
  date: string;
  number: number;
  views: { web: number; email: number };
  finishes: number;
  shares: number;
  useful: number;
  notUseful: number;
  reports: number;
}

interface Stats {
  issues: IssueStats[];
  engagement: { subscribers: number; lastIssues: string[]; regular: number; share: number | null; target: number };
  survey: { very: number; somewhat: number; not: number; share: number | null; target: number };
}

const pct = (value: number | null) => (value === null ? '–' : `${Math.round(value * 100)}%`);
const ratio = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '–');

export default function StatsView() {
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Stats>('/api/admin/stats').then(setData, (cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const e = data?.engagement;
  const s = data?.survey;
  const answers = s ? s.very + s.somewhat + s.not : 0;
  return (
    <section className="panel">
      <h2>Stats</h2>
      <p className="muted">
        Daily totals, never per person. A view counts once per visit; “finished” means the reader reached the end of the issue. Email opens are not tracked, so “from email” counts readers who clicked through.
      </p>
      {error && <div className="notice error">{error}</div>}

      {e && s && (
        <>
          <h3>Launch gate: readers</h3>
          <table className="counts">
            <tbody>
              <tr>
                <th>Want it</th>
                <td>
                  <strong>{pct(e.share)}</strong> of {e.subscribers} confirmed subscribers opened at least 3 of the last 5 issues ({e.regular} people). Bar: {pct(e.target)}.
                  {e.lastIssues.length < 5 && <span className="muted"> Needs 5 published issues.</span>}
                </td>
              </tr>
              <tr>
                <th>Can’t do without it</th>
                <td>
                  <strong>{pct(s.share)}</strong> of {answers} answers say “very disappointed” ({s.very} very, {s.somewhat} somewhat, {s.not} not). Bar: {pct(s.target)}. Asked of subscribers after 3 issues.
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">An issue opened on a device where the reader is signed in (from the confirmation link, a sign-in link or any issue email) counts as opened by them.</p>
        </>
      )}

      <h3>Issues</h3>
      {data && data.issues.length === 0 && <p className="muted small">Nothing published yet.</p>}
      {data && data.issues.length > 0 && (
        <table className="counts wide">
          <thead>
            <tr>
              <th>Issue</th>
              <th>Views</th>
              <th>From email</th>
              <th>Finished</th>
              <th>Shares</th>
              <th>Useful</th>
              <th>Reports</th>
            </tr>
          </thead>
          <tbody>
            {data.issues.map((i) => {
              const views = i.views.web + i.views.email;
              return (
                <tr key={i.date}>
                  <th>
                    {i.date} · #{i.number}
                  </th>
                  <td>{views}</td>
                  <td>{i.views.email}</td>
                  <td>
                    {i.finishes} <span className="muted">({ratio(i.finishes, views)})</span>
                  </td>
                  <td>{i.shares}</td>
                  <td>
                    {i.useful} / {i.useful + i.notUseful}
                  </td>
                  <td>{i.reports}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
