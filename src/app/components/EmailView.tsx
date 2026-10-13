/**
 * /admin#email: is sending configured, how many subscribers in each state, what went out
 * each day, the issue as it looks in an inbox, and a test send to one address. Counts
 * only: the API never returns subscribers' addresses.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface EmailStatus {
  provider: 'resend' | 'none';
  from: string | null;
  siteUrl: string | null;
  postalAddress: string | null;
  contactEmail: string | null;
  webhook: boolean;
  turnstile: boolean;
  subscribers: { status: string; lang: string; n: number }[];
  deliveries: { date: string; sent: number; failed: number; sending: number }[];
  lastError: string | null;
}

interface IssueRow {
  date: string;
  number: number;
  status: string;
}

const STATUSES = ['confirmed', 'pending', 'unsubscribed', 'bounced', 'complained'] as const;

export default function EmailView() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [date, setDate] = useState('');
  const [lang, setLang] = useState<'en' | 'zh'>('en');
  const [preview, setPreview] = useState<{ subject: string; html: string; bytes: number } | null>(null);
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api<EmailStatus>('/api/admin/email'), api<{ issues: IssueRow[] }>('/api/admin/issues')]);
      setStatus(s);
      setIssues(list.issues);
      setDate((d) => d || list.issues[0]?.date || '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!date) return;
    setPreview(null);
    api<{ subject: string; html: string; bytes: number }>(`/api/admin/email/preview?date=${encodeURIComponent(date)}&lang=${lang}`).then(setPreview, (cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [date, lang]);

  const sendTest = async () => {
    setNote('Sending…');
    setError('');
    try {
      const r = await api<{ ok: boolean; error?: string }>('/api/admin/email/test', { method: 'POST', body: JSON.stringify({ date, lang, to }) });
      setNote(r.ok ? `Sent to ${to}. Check that inbox, and the spam folder.` : '');
      if (!r.ok) setError(r.error ?? 'The send failed.');
      void refresh();
    } catch (cause) {
      setNote('');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const count = (s: string, l?: string) => status?.subscribers.filter((r) => r.status === s && (!l || r.lang === l)).reduce((n, r) => n + r.n, 0) ?? 0;
  const ready = status?.provider === 'resend' && Boolean(status.siteUrl);

  return (
    <section className="panel">
      <h2>Email</h2>
      <p className="muted">
        Confirmed subscribers get the published issue at 7:00 their local time (sent between 07:00 and 12:00; an issue published later waits for the next one). Every email
        carries a one-click unsubscribe link.
      </p>
      {error && <div className="notice error">{error}</div>}

      <h3>Sending</h3>
      {status &&
        (ready ? (
          <p className="small">
            <span className="badge ok">ready</span> Resend, from <code>{status.from}</code>; links point to <code>{status.siteUrl}</code>.
          </p>
        ) : (
          <div className="notice">
            <p>
              <strong>Not sending yet.</strong> Subscriptions are recorded and confirmations are logged, but nothing leaves the site until these are set:
            </p>
            <ul className="small">
              <li>{status.provider === 'resend' ? '✓' : '✗'} a verified sending domain in Resend, then <code>npx wrangler secret put RESEND_API_KEY</code> and <code>npx wrangler secret put EMAIL_FROM</code></li>
              <li>
                {status.siteUrl ? '✓' : '✗'} <code>SITE_URL</code> in wrangler.jsonc{status.siteUrl ? `: ${status.siteUrl}` : ''}
              </li>
            </ul>
          </div>
        ))}
      {status?.lastError && <p className="warn small">Last problem: {status.lastError}</p>}

      <h3>Compliance and deliverability</h3>
      {status && (
        <ul className="small checklist">
          <li>
            {status.postalAddress ? '✓' : '✗'} Postal address in every footer (CAN-SPAM){status.postalAddress ? `: ${status.postalAddress}` : ': set EMAIL_POSTAL_ADDRESS in wrangler.jsonc'}
          </li>
          <li>
            {status.contactEmail ? '✓' : '✗'} Replies go to a person{status.contactEmail ? `: ${status.contactEmail}` : ': set CONTACT_EMAIL, or replies to the sending domain bounce'}
          </li>
          <li>✓ One-click unsubscribe in every email, and “delete my data” on its page</li>
          <li>
            {status.webhook ? '✓' : '✗'} Bounces and spam complaints stop further email
            {status.webhook
              ? ''
              : ': in Resend, add a webhook to <SITE_URL>/api/webhooks/resend for email.bounced and email.complained, then npx wrangler secret put RESEND_WEBHOOK_SECRET'}
          </li>
          <li>
            {status.turnstile ? '✓' : '✗'} Bot check on the subscribe form{status.turnstile ? ' (Turnstile)' : ': set TURNSTILE_SITE_KEY and the TURNSTILE_SECRET_KEY secret'}
          </li>
        </ul>
      )}

      <h3>Subscribers</h3>
      {status && (
        <table className="counts">
          <thead>
            <tr>
              <th />
              <th>English</th>
              <th>中文</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {STATUSES.map((s) => (
              <tr key={s}>
                <th>{s}</th>
                <td>{count(s, 'en')}</td>
                <td>{count(s, 'zh')}</td>
                <td>{count(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Deliveries</h3>
      {status && status.deliveries.length === 0 && <p className="muted small">No issue has been emailed yet.</p>}
      <ul className="run-list">
        {status?.deliveries.map((d) => (
          <li key={d.date} className="small">
            <strong>{d.date}</strong> · {d.sent} sent{d.failed ? ` · ${d.failed} failed` : ''}
            {d.sending ? ` · ${d.sending} in flight` : ''}
          </li>
        ))}
      </ul>

      <h3>Preview</h3>
      {issues.length === 0 ? (
        <p className="muted small">No issues yet.</p>
      ) : (
        <>
          <div className="row">
            <select className="select" value={date} onChange={(e) => setDate(e.target.value)}>
              {issues.map((i) => (
                <option key={i.date} value={i.date}>
                  {i.date} · #{i.number} ({i.status})
                </option>
              ))}
            </select>
            <select className="select" value={lang} onChange={(e) => setLang(e.target.value === 'zh' ? 'zh' : 'en')}>
              <option value="en">English</option>
              <option value="zh">中文</option>
            </select>
          </div>
          {preview && (
            <>
              <p className="small">
                <strong>Subject:</strong> {preview.subject} <span className="muted">· {Math.round(preview.bytes / 1024)} KB of HTML (Gmail clips above ~100 KB)</span>
              </p>
              {/* No allow-scripts: the email cannot run code or navigate this page. */}
              <iframe className="email-preview" title="Email preview" srcDoc={preview.html} sandbox="allow-same-origin" />
            </>
          )}
          <div className="row">
            <input type="email" placeholder="you@example.com" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Test address" />
            <button className="button" disabled={!ready || !to || !date} onClick={() => void sendTest()}>
              Send a test
            </button>
          </div>
          {note && <p className="muted small">{note}</p>}
        </>
      )}
    </section>
  );
}
