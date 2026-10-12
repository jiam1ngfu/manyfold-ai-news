/**
 * /admin#questions: readers' own questions. Pause or resume asking, set the site-wide
 * daily limit (the cost ceiling), see how often the sources cover what readers ask (the
 * signal for building "look further"), and read recent questions. No addresses: askers
 * are only ever a salted hash, and that is not shown either.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface Overview {
  enabled: boolean;
  dailyLimit: number;
  perReader: number;
  answerer: string | null;
  days: { day: string; asked: number; cached: number; answered: number; partial: number; none: number; failed: number }[];
  recent: { at: string; issueDate: string; storyId: string; lang: string; question: string; status: string; dropped: number; cached: boolean; error: string | null }[];
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '–');

export default function QuestionsView() {
  const [data, setData] = useState<Overview | null>(null);
  const [limit, setLimit] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (init?: RequestInit) => {
    setError('');
    try {
      const next = await api<Overview>('/api/admin/ask', init);
      setData(next);
      setLimit(String(next.dailyLimit));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = (body: Record<string, unknown>) => void load({ method: 'PUT', body: JSON.stringify(body) });
  const week = data?.days.slice(0, 7) ?? [];
  const total = (key: 'asked' | 'cached' | 'answered' | 'partial' | 'none' | 'failed') => week.reduce((n, d) => n + d[key], 0);

  return (
    <section className="panel">
      <h2>Questions</h2>
      <p className="muted">
        Confirmed subscribers ask about a story; the answer agent replies from that story’s sources only, and code checks every quote and value before a reader sees
        it. Each new question is one billed agent turn; repeats of the same question are answered from the cache for free.
      </p>
      {error && <div className="notice error">{error}</div>}
      {data && (
        <>
          <h3>Settings</h3>
          <div className="row">
            <span className={data.enabled ? 'badge ok' : 'badge warn'}>{data.enabled ? 'open' : 'paused'}</span>
            <button className="button subtle" onClick={() => save({ enabled: !data.enabled })}>
              {data.enabled ? 'Pause asking' : 'Resume asking'}
            </button>
          </div>
          <p className="small">
            Answer agent: {data.answerer ?? <strong>none chosen. Pick one under Issues → Agents; until then asking is paused.</strong>} · {data.perReader} questions per
            reader per day
          </p>
          <div className="row">
            <label className="small" htmlFor="ask-limit">
              New questions per day, whole site
            </label>
            <input id="ask-limit" type="number" min={0} max={10000} value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 100 }} />
            <button className="button subtle" disabled={limit === String(data.dailyLimit)} onClick={() => save({ dailyLimit: Number(limit) })}>
              Save
            </button>
          </div>

          <h3>Last 7 days</h3>
          {week.length === 0 ? (
            <p className="muted small">No questions yet.</p>
          ) : (
            <>
              <p className="small">
                {total('asked')} asked ({total('cached')} from the cache) · answered {pct(total('answered'), total('asked'))} · partly {pct(total('partial'), total('asked'))} ·{' '}
                <strong>not in the sources {pct(total('none'), total('asked'))}</strong> · failed {pct(total('failed'), total('asked'))}
              </p>
              <p className="muted small">A high “not in the sources” share is the signal to build “look further” (step 3 in the product plan).</p>
              <table className="counts">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Asked</th>
                    <th>Cached</th>
                    <th>Answered</th>
                    <th>Partly</th>
                    <th>Not covered</th>
                    <th>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {week.map((d) => (
                    <tr key={d.day}>
                      <th>{d.day}</th>
                      <td>{d.asked}</td>
                      <td>{d.cached}</td>
                      <td>{d.answered}</td>
                      <td>{d.partial}</td>
                      <td>{d.none}</td>
                      <td>{d.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h3>Recent questions</h3>
          {data.recent.length === 0 && <p className="muted small">None yet.</p>}
          <ul className="run-list">
            {data.recent.map((q, i) => (
              <li key={i} className="small">
                <span className={q.status === 'failed' ? 'badge warn' : q.status === 'none' ? 'badge' : 'badge ok'}>{q.status}</span> {q.question}
                <div className="muted">
                  {q.at.slice(0, 16).replace('T', ' ')} UTC · {q.issueDate} · {q.storyId} · {q.lang}
                  {q.cached ? ' · from cache' : ''}
                  {q.dropped ? ` · ${q.dropped} sentence${q.dropped === 1 ? '' : 's'} dropped by the checks` : ''}
                  {q.error ? ` · ${q.error}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
