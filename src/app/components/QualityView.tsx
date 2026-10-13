/**
 * /admin#quality: keeping published issues right. The launch gate (five issues in a row
 * with no factual error), the owner's check of each issue, readers' problem reports, and
 * the correction desk: fix a story's text with a note, or withdraw a story or brief.
 * Corrections are public: they show on the story, in the corrections log and in the next
 * email.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CorrectionEntry, Issue, L10n } from '../../shared/issue';
import { api } from '../api';
import { withBase } from '../../shared/base';

interface QualityIssue {
  date: string;
  number: number;
  items: number;
  verdict: 'clean' | 'errors' | null;
  note: string | null;
  corrections: number;
  openReports: number;
}

interface ReportRow {
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

interface Overview {
  gate: { needed: number; streak: number; waiting: string[]; brokenBy: string | null };
  issues: QualityIssue[];
  reports: ReportRow[];
  corrections: CorrectionEntry[];
}

const FIELDS = ['title', 'summary', 'why', 'next'] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABEL: Record<Field, string> = { title: 'Headline', summary: 'Summary', why: 'Why it matters', next: 'What to watch' };
const emptyL10n = (): L10n => ({ en: '', zh: '' });

/** Correct a story's text, or withdraw a story or a brief, in one published issue. */
function CorrectionDesk({ date, initialTarget, onDone, onCancel }: { date: string; initialTarget: string | null; onDone: () => void; onCancel: () => void }) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [target, setTarget] = useState(initialTarget ?? '');
  const [kind, setKind] = useState<'corrected' | 'withdrawn'>('corrected');
  const [fix, setFix] = useState<Partial<Record<Field, L10n>>>({});
  const [note, setNote] = useState<L10n>(emptyL10n);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ issue: Issue }>(`/api/admin/issues/${date}`).then(
      (r) => setIssue(r.issue),
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [date]);

  const story = issue?.stories.find((s) => s.id === target) ?? null;
  const isBrief = target.startsWith('brief-');

  useEffect(() => {
    if (!story) return setFix({});
    setFix(Object.fromEntries(FIELDS.filter((f) => story[f]).map((f) => [f, { ...story[f]! }])) as Partial<Record<Field, L10n>>);
  }, [story]);

  useEffect(() => {
    if (isBrief) setKind('withdrawn');
  }, [isBrief]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const changed = story ? Object.fromEntries(FIELDS.filter((f) => fix[f] && (fix[f]!.en !== story[f]?.en || fix[f]!.zh !== story[f]?.zh)).map((f) => [f, fix[f]])) : {};
      if (kind === 'corrected' && Object.keys(changed).length === 0) throw new Error('Change the text of at least one field, or withdraw the story instead.');
      await api(`/api/admin/issues/${date}/correct`, { method: 'POST', body: JSON.stringify({ kind, target, note, ...(kind === 'corrected' ? { fix: changed } : {}) }) });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!issue) return error ? <div className="notice error">{error}</div> : <p className="muted small">Loading the issue…</p>;
  return (
    <form className="desk" onSubmit={submit}>
      <h4>
        Correct #{issue.number} · {date}
      </h4>
      <label className="small">
        What
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} required>
          <option value="" disabled>
            Choose a story or brief
          </option>
          {issue.stories.map((s, i) => (
            <option key={s.id} value={s.id}>
              Story {i + 1}: {s.title.en}
            </option>
          ))}
          {issue.briefs.map((b, i) => (
            <option key={i} value={`brief-${i}`}>
              Brief {i + 1}: {b.text.en.slice(0, 90)}
            </option>
          ))}
        </select>
      </label>
      {target && (
        <div className="row">
          <label className="small">
            <input type="radio" name="kind" checked={kind === 'corrected'} disabled={isBrief} onChange={() => setKind('corrected')} /> Correct the text
          </label>
          <label className="small">
            <input type="radio" name="kind" checked={kind === 'withdrawn'} onChange={() => setKind('withdrawn')} /> Withdraw it from the issue
          </label>
        </div>
      )}
      {kind === 'corrected' && story && (
        <div className="desk-fields">
          <p className="muted small">
            Edit the words that were wrong, in both languages. Keep the &lt;m0&gt;…&lt;/m0&gt; markers around checked numbers, or remove a marker together with its number.
          </p>
          {FIELDS.filter((f) => fix[f]).map((f) => (
            <div key={f} className="desk-pair">
              <span className="small">{FIELD_LABEL[f]}</span>
              <textarea rows={f === 'title' ? 2 : 4} value={fix[f]!.en} onChange={(e) => setFix((x) => ({ ...x, [f]: { ...x[f]!, en: e.target.value } }))} aria-label={`${FIELD_LABEL[f]} (English)`} />
              <textarea rows={f === 'title' ? 2 : 4} value={fix[f]!.zh} onChange={(e) => setFix((x) => ({ ...x, [f]: { ...x[f]!, zh: e.target.value } }))} aria-label={`${FIELD_LABEL[f]} (中文)`} />
            </div>
          ))}
        </div>
      )}
      {target && (
        <div className="desk-pair">
          <span className="small">Note to readers: what was wrong and what changed</span>
          <textarea rows={2} required placeholder="An earlier version said the model had 70B parameters. The source says 7B." value={note.en} onChange={(e) => setNote((n) => ({ ...n, en: e.target.value }))} aria-label="Note (English)" />
          <textarea rows={2} required placeholder="此前版本称该模型有 700 亿参数，来源原文为 70 亿。" value={note.zh} onChange={(e) => setNote((n) => ({ ...n, zh: e.target.value }))} aria-label="Note (中文)" />
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
      <div className="row">
        <button className="button" type="submit" disabled={!target || saving}>
          {kind === 'withdrawn' ? 'Withdraw and publish the note' : 'Publish the correction'}
        </button>
        <button className="button subtle" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="muted small">Readers see it at once, on the story and in the corrections log; the next issue email lists it. It also counts as an error for the launch gate.</p>
    </form>
  );
}

export default function QualityView() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [desk, setDesk] = useState<{ date: string; target: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>('/api/admin/quality'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (path: string, body: unknown) => {
    setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const gate = data?.gate;
  return (
    <section className="panel">
      <h2>Quality</h2>
      <p className="muted">
        Check published issues against their sources, answer readers’ reports, and correct openly. During the trial, check every issue; after launch, spot-check about 30 minutes a week.
      </p>
      {error && <div className="notice error">{error}</div>}

      {gate && (
        <>
          <h3>Launch gate</h3>
          <div className={gate.streak >= gate.needed ? 'notice' : 'notice warn-notice'}>
            <p>
              <strong>
                {gate.streak} of {gate.needed}
              </strong>{' '}
              issues in a row checked with no factual error{gate.streak >= gate.needed ? ': the accuracy bar is met.' : '.'}
            </p>
            {gate.waiting.length > 0 && <p className="small">Waiting for your check: {gate.waiting.join(', ')}.</p>}
            {gate.brokenBy && <p className="small">The run of clean issues stops at {gate.brokenBy}, which had an error or a correction.</p>}
            <p className="small muted">
              The other two bars (40% of subscribers open 3 of 5 issues; 40% would be very disappointed without it) are under{' '}
              <a className="link" href="#stats">
                Stats
              </a>
              .
            </p>
          </div>
        </>
      )}

      {desk && (
        <CorrectionDesk key={`${desk.date}:${desk.target ?? ''}`} date={desk.date} initialTarget={desk.target} onCancel={() => setDesk(null)} onDone={() => (setDesk(null), void load())} />
      )}

      <h3>Readers’ reports</h3>
      {data && data.reports.length === 0 && <p className="muted small">No open reports.</p>}
      <ul className="run-list">
        {data?.reports.map((r) => (
          <li key={r.id}>
            <strong>{r.issueDate}</strong> ·{' '}
            {r.position ? (
              <a className="link" href={withBase(`/${r.lang}/${r.issueDate}/${r.position}`)} target="_blank" rel="noreferrer">
                {r.storyTitle ?? r.storyId}
              </a>
            ) : (
              <span>{r.storyTitle ?? r.storyId}</span>
            )}{' '}
            <span className="badge">{r.target}</span> <span className="muted small">{r.lang === 'zh' ? '中文' : 'English'} · {new Date(r.createdAt).toLocaleString()}</span>
            <div className="small">{r.note ? `“${r.note}”` : <span className="muted">No note.</span>}</div>
            <div className="row">
              <button className="button subtle" onClick={() => void act(`/api/admin/reports/${r.id}`, { status: 'resolved' })}>
                Checked: no error
              </button>
              <button className="button" onClick={() => setDesk({ date: r.issueDate, target: r.storyId })}>
                Correct or withdraw…
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h3>Published issues</h3>
      {data && data.issues.length === 0 && <p className="muted small">Nothing published yet.</p>}
      <ul className="run-list">
        {data?.issues.map((i) => (
          <li key={i.date}>
            <strong>{i.date}</strong> · #{i.number} · {i.items} items{' '}
            {i.verdict === 'clean' && <span className="badge ok">no errors</span>}
            {i.verdict === 'errors' && <span className="badge warn">errors</span>}
            {i.verdict === null && <span className="badge">not checked</span>} {i.corrections > 0 && <span className="badge warn">{i.corrections} corrected</span>}{' '}
            {i.openReports > 0 && <span className="badge warn">{i.openReports} open reports</span>}{' '}
            <a className="link" href={withBase(`/en/${i.date}`)} target="_blank" rel="noreferrer">
              Read
            </a>{' '}
            <a className="link" href={withBase(`/zh/${i.date}`)} target="_blank" rel="noreferrer">
              中文
            </a>
            {i.note && <div className="small muted">{i.note}</div>}
            <div className="row">
              <button className="button subtle" onClick={() => void act(`/api/admin/issues/${i.date}/check`, { verdict: 'clean' })}>
                No factual errors
              </button>
              <button className="button subtle" onClick={() => void act(`/api/admin/issues/${i.date}/check`, { verdict: 'errors' })}>
                Found an error
              </button>
              {i.verdict && (
                <button className="button subtle" onClick={() => void act(`/api/admin/issues/${i.date}/check`, { verdict: null })}>
                  Clear
                </button>
              )}
              <button className="button" onClick={() => setDesk({ date: i.date, target: null })}>
                Correct or withdraw…
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h3>Corrections log</h3>
      {data && data.corrections.length === 0 && <p className="muted small">No corrections yet.</p>}
      <ul className="run-list">
        {data?.corrections.map((c, n) => (
          <li key={n} className="small">
            <strong>{c.date}</strong> <span className={c.kind === 'withdrawn' ? 'badge warn' : 'badge'}>{c.kind}</span> {c.title.en.replace(/<\/?m\d+>/g, '')}
            <div className="muted">{c.note.en}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
