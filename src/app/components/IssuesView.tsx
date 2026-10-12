/**
 * The owner's issue desk at /admin#issues: choose the writer and review agents, run the
 * pipeline, read each run report (what passed check 1, what the reviewer passed, fixed
 * or cut, and why), preview drafts in the real reader, and publish. During the trial
 * period nothing is published without a click here.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ConnectedAgent } from '../../shared/types';
import { api } from '../api';
import { withBase } from '../../shared/base';

interface RunSummary {
  id: string;
  issueDate: string;
  trigger: string;
  status: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  stories: number;
  briefs: number;
}

interface ItemCheck {
  id: string;
  title: string;
  kept: boolean;
  reasons: string[];
  warnings: string[];
}

interface ReviewItem {
  id: string;
  title: string;
  verdict: 'pass' | 'fix' | 'cut' | 'missing';
  problems: string[];
  changed: string[];
  kept: boolean;
  notes: string[];
}

interface RunReport {
  agent: string | null;
  reviewer?: string | null;
  step: string;
  candidates: number;
  picked: number;
  sourcesFetched: number;
  sourceFailures: { url: string; error: string }[];
  feeds: { feed: string; items: number; error?: string }[];
  checks: ItemCheck[];
  /** Older runs stored a sentence here, before check 2 existed. */
  review: { agent: string; items: ReviewItem[]; top?: { from: string; to: string } } | string | null;
  translationWarnings: string[];
  durationMs: number;
}

interface IssueRow {
  date: string;
  number: number;
  status: string;
  updatedAt: string;
}

const VERDICT: Record<ReviewItem['verdict'], string> = { pass: 'passed', fix: 'fixed', cut: 'cut', missing: 'not reviewed' };

function Review({ review }: { review: RunReport['review'] }) {
  if (!review) return null;
  if (typeof review === 'string') return <p className="warn small">{review}</p>;
  const count = (v: ReviewItem['verdict']) => review.items.filter((i) => i.verdict === v).length;
  return (
    <>
      <h4>Check 2: review by {review.agent}</h4>
      <p className="muted small">
        {count('pass')} passed · {count('fix')} fixed · {count('cut') + count('missing')} cut
        {review.top ? ` · lead moved from “${review.top.from}” to “${review.top.to}”` : ''}
      </p>
      <ul className="check-list">
        {review.items.map((item) => (
          <li key={item.id}>
            <span className={item.kept ? 'badge ok' : 'badge warn'}>{item.kept ? VERDICT[item.verdict] : 'cut'}</span> {item.title}
            {item.problems.map((problem) => (
              <div key={problem} className="small warn">
                {problem}
              </div>
            ))}
            {item.changed.length > 0 && <div className="small muted">Changed: {item.changed.join(', ')}</div>}
            {item.notes.map((note) => (
              <div key={note} className="small muted">
                {note}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}

function RunDetails({ id }: { id: string }) {
  const [run, setRun] = useState<{ status: string; error: string | null; report: RunReport | null } | null>(null);
  useEffect(() => {
    api<{ status: string; error: string | null; report: RunReport | null }>(`/api/admin/pipeline/runs/${encodeURIComponent(id)}`).then(setRun, () => setRun(null));
  }, [id]);
  if (!run) return <p className="muted small">Loading report…</p>;
  const r = run.report;
  return (
    <div className="run-details">
      {run.error && <div className="notice error">{run.error}</div>}
      {r && (
        <>
          <p className="muted small">
            Writer {r.agent ?? 'none'}
            {r.reviewer ? ` · reviewer ${r.reviewer}` : ''} · {r.candidates} candidates · {r.picked} picked · {r.sourcesFetched} sources read · stopped at “{r.step}” · {Math.round(r.durationMs / 1000)} s
          </p>
          {r.checks.length > 0 && <h4>Check 1: quotes and numbers</h4>}
          {r.checks.length > 0 && (
            <ul className="check-list">
              {r.checks.map((c) => (
                <li key={c.id}>
                  <span className={c.kept ? 'badge ok' : 'badge warn'}>{c.kept ? 'kept' : 'cut'}</span> {c.title}
                  {c.reasons.map((reason) => (
                    <div key={reason} className="small warn">
                      {reason}
                    </div>
                  ))}
                  {c.warnings.map((warning) => (
                    <div key={warning} className="small muted">
                      {warning}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
          <Review review={r.review} />
          {r.translationWarnings.length > 0 && (
            <details>
              <summary className="small">{r.translationWarnings.length} translation notes</summary>
              {r.translationWarnings.map((w) => (
                <div key={w} className="small muted">
                  {w}
                </div>
              ))}
            </details>
          )}
          <details>
            <summary className="small">Feeds and sources</summary>
            {r.feeds.map((f) => (
              <div key={f.feed} className="small muted">
                {f.feed}: {f.error ? `error, ${f.error}` : `${f.items} items in the window`}
              </div>
            ))}
            {r.sourceFailures.map((f) => (
              <div key={f.url} className="small warn">
                Could not read {f.url}: {f.error}
              </div>
            ))}
          </details>
        </>
      )}
    </div>
  );
}

export default function IssuesView({ agents }: { agents: ConnectedAgent[] }) {
  const [writer, setWriter] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [sources, setSources] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pipeline, list] = await Promise.all([
        api<{ writerAgentId: string | null; reviewerAgentId: string | null; runs: RunSummary[] }>('/api/admin/pipeline'),
        api<{ issues: IssueRow[] }>('/api/admin/issues'),
      ]);
      setWriter(pipeline.writerAgentId);
      setReviewer(pipeline.reviewerAgentId);
      setRuns(pipeline.runs);
      setIssues(list.issues);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const chooseAgent = async (role: 'writer' | 'reviewer', agentId: string) => {
    setError('');
    try {
      await api('/api/admin/pipeline/agent', { method: 'PUT', body: JSON.stringify({ role, agentId }) });
      (role === 'writer' ? setWriter : setReviewer)(agentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const runNow = async () => {
    setConfirming(false);
    setRunning(true);
    setError('');
    try {
      const result = await api<{ runId: string }>('/api/admin/pipeline/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      setOpen(result.runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
      void refresh();
    }
  };

  const checkSources = async () => {
    setSources('Reading the feeds…');
    try {
      const r = await api<{ feeds: { feed: string; items: number; error?: string }[]; candidates: unknown[]; sources: { characters: number }[]; failures: unknown[] }>('/api/admin/pipeline/sources');
      const broken = r.feeds.filter((f) => f.error).map((f) => `${f.feed} (${f.error})`);
      setSources(
        `${r.candidates.length} candidate stories from ${r.feeds.length - broken.length} of ${r.feeds.length} feeds. ` +
          `Read ${r.sources.length} sample sources, ${r.failures.length} failed.` +
          (broken.length ? ` Not responding: ${broken.join(', ')}.` : ''),
      );
    } catch (cause) {
      setSources(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const setStatus = async (date: string, status: 'published' | 'draft') => {
    setError('');
    try {
      await api(`/api/admin/issues/${date}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="panel">
      <h2>Issues</h2>
      <p className="muted">
        The pipeline runs every day at 19:30 UTC (and retries once at 20:30 if that fails) and saves a <strong>draft</strong>. Read the draft, check the run report, then publish it. Nothing reaches readers until you do.
      </p>

      <h3>Agents</h3>
      {agents.length < 2 ? (
        <p className="muted">Connect two agents in Settings: one writes, a different one reviews.</p>
      ) : null}
      {agents.length > 0 && (
        <div className="agent-roles">
          <label>
            <span className="small muted">Writer: picks, writes and translates</span>
            <select className="select" value={writer ?? ''} onChange={(e) => void chooseAgent('writer', e.target.value)}>
              <option value="" disabled>
                Choose the writer
              </option>
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId} disabled={a.agentId === reviewer}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="small muted">Reviewer: checks the draft against the sources (check 2)</span>
            <select className="select" value={reviewer ?? ''} onChange={(e) => void chooseAgent('reviewer', e.target.value)}>
              <option value="" disabled>
                Choose a different agent to review
              </option>
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId} disabled={a.agentId === writer}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <h3>Run now</h3>
      {confirming ? (
        <div className="row">
          <span className="warn small">A run makes four billed agent calls (three to the writer, one to the reviewer) and takes a few minutes.</span>
          <button className="button" onClick={() => void runNow()}>
            Run it
          </button>
          <button className="button subtle" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <span className="row">
          <button className="button" disabled={running || !writer || !reviewer} onClick={() => setConfirming(true)}>
            {running ? 'Running… keep this page open' : 'Run the pipeline'}
          </button>
          <button className="button subtle" onClick={() => void checkSources()}>
            Check sources (free)
          </button>
        </span>
      )}
      {sources && <p className="muted small">{sources}</p>}

      {error && <div className="notice error">{error}</div>}

      <h3>Runs</h3>
      {runs.length === 0 && <p className="muted">No runs yet.</p>}
      <ul className="run-list">
        {runs.map((run) => (
          <li key={run.id}>
            <button className="link" onClick={() => setOpen(open === run.id ? null : run.id)}>
              {run.issueDate} · run {run.id.split('-').pop()} · {run.trigger}
            </button>{' '}
            <span className={run.status === 'drafted' ? 'badge ok' : run.status === 'failed' ? 'badge warn' : 'badge'}>{run.status}</span>{' '}
            <span className="muted small">
              {run.status === 'drafted' ? `${run.stories} stories, ${run.briefs} briefs` : run.error ?? ''}
            </span>
            {open === run.id && <RunDetails id={run.id} />}
          </li>
        ))}
      </ul>

      <h3>Issues</h3>
      {issues.length === 0 && <p className="muted">No issues yet.</p>}
      <ul className="run-list">
        {issues.map((issue) => (
          <li key={issue.date}>
            <strong>{issue.date}</strong> · #{issue.number} <span className={issue.status === 'published' ? 'badge ok' : 'badge'}>{issue.status}</span>{' '}
            <a className="link" href={withBase(`/en/${issue.date}?preview=1`)}>
              Preview EN
            </a>{' '}
            <a className="link" href={withBase(`/zh/${issue.date}?preview=1`)}>
              中文
            </a>{' '}
            {issue.status === 'published' ? (
              <button className="button subtle" onClick={() => void setStatus(issue.date, 'draft')}>
                Unpublish
              </button>
            ) : (
              <button className="button" onClick={() => void setStatus(issue.date, 'published')}>
                Publish
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
