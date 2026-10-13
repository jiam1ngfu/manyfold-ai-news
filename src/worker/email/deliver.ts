/**
 * Who gets which email, and when.
 *
 * Every 15 minutes the scheduled handler calls deliverDue: each confirmed subscriber
 * whose local time is between 07:00 and 12:00 gets the issue for their local date, as
 * soon as it is published. An issue published after noon local time waits for the next
 * morning's issue instead of arriving stale. A recipient is claimed in email_log before
 * the send, so a retried or overlapping tick can never send a second copy.
 */

import type { Issue, Lang } from '../../shared/issue';
import type { Env } from '../types';
import { now } from '../db';
import { safeErrorText } from '../a2a';
import { ASK_KEY, renderConfirmEmail, renderIssueEmail, renderSignInEmail, UNSUBSCRIBE } from './render';
import { BATCH_SIZE, provider, sendBatch, type Mail } from './send';
import { askToken, confirmToken, signInToken, SIGNIN_MINUTES, unsubscribeToken } from './tokens';

export const SEND_FROM_HOUR = 7;
export const SEND_UNTIL_HOUR = 12;
// Keeps one tick inside Workers' per-invocation limits (D1 queries, subrequests).
const MAX_PER_TICK = 200;
const MAX_ATTEMPTS = 3;
const CONFIRM_BACKLOG_PER_TICK = 5;
// D1 allows 100 bound parameters per statement.
const CLAIM_CHUNK = 24;

export interface Subscriber {
  email: string;
  lang: Lang;
  timezone: string;
}

/** The subscriber's calendar date and hour. An unknown time zone counts as UTC. */
export function localClock(at: Date, timeZone: string): { date: string; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  }
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

/** Subscribers inside their morning window, grouped by their local date. */
export function dueByDate(subscribers: Subscriber[], at: Date): Map<string, Subscriber[]> {
  const due = new Map<string, Subscriber[]>();
  for (const s of subscribers) {
    const clock = localClock(at, s.timezone);
    if (clock.hour < SEND_FROM_HOUR || clock.hour >= SEND_UNTIL_HOUR) continue;
    due.set(clock.date, [...(due.get(clock.date) ?? []), s]);
  }
  return due;
}

const siteUrl = (env: Env, fallback?: string): string | null => {
  const url = (env.SITE_URL ?? '').trim() || fallback || '';
  return /^https?:\/\/[^\s/]+/.test(url) ? url.replace(/\/+$/, '') : null;
};

/**
 * One recipient's copy: their own unsubscribe link (in the body and as one-click headers)
 * and their ask key on every story link.
 */
async function personalise(env: Env, site: string, lang: Lang, email: string, rendered: { subject: string; html: string; text: string }): Promise<Mail> {
  const token = await unsubscribeToken(env, email);
  const page = `${site}/${lang}/unsubscribe?t=${encodeURIComponent(token)}`;
  const oneClick = `${site}/api/unsubscribe?t=${encodeURIComponent(token)}`;
  const key = encodeURIComponent(await askToken(env, email));
  const fill = (body: string, unsubscribe: string) => body.split(UNSUBSCRIBE).join(unsubscribe).split(ASK_KEY).join(key);
  return {
    to: email,
    subject: rendered.subject,
    html: fill(rendered.html, page.replace(/&/g, '&amp;')),
    text: fill(rendered.text, page),
    headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

/** Claims recipients for one issue: new ones, plus earlier failures with attempts left. */
async function claim(env: Env, date: string, emails: string[]): Promise<string[]> {
  const at = now();
  const claimed: string[] = [];
  for (let i = 0; i < emails.length; i += CLAIM_CHUNK) {
    const chunk = emails.slice(i, i + CLAIM_CHUNK);
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO email_log (email, kind, ref, status, attempts, created_at, updated_at) VALUES ${chunk.map(() => "(?, 'issue', ?, 'sending', 1, ?, ?)").join(', ')} RETURNING email`,
    )
      .bind(...chunk.flatMap((email) => [email, date, at, at]))
      .all<{ email: string }>();
    const retried = await env.DB.prepare(
      `UPDATE email_log SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE kind = 'issue' AND ref = ? AND status = 'failed' AND attempts < ${MAX_ATTEMPTS} AND email IN (${chunk.map(() => '?').join(', ')}) RETURNING email`,
    )
      .bind(at, date, ...chunk)
      .all<{ email: string }>();
    claimed.push(...inserted.results.map((r) => r.email), ...retried.results.map((r) => r.email));
  }
  return claimed;
}

async function settle(env: Env, kind: string, ref: string, results: { to: string; ok: boolean; error?: string }[]): Promise<void> {
  const at = now();
  for (const ok of [true, false]) {
    const group = results.filter((r) => r.ok === ok);
    for (let i = 0; i < group.length; i += 90) {
      const chunk = group.slice(i, i + 90);
      await env.DB.prepare(`UPDATE email_log SET status = ?, error = ?, updated_at = ? WHERE kind = ? AND ref = ? AND email IN (${chunk.map(() => '?').join(', ')})`)
        .bind(ok ? 'sent' : 'failed', ok ? null : (chunk[0].error ?? 'Send failed.').slice(0, 300), at, kind, ref, ...chunk.map((r) => r.to))
        .run();
    }
  }
}

export interface DeliveryTick {
  provider: string;
  due: number;
  sent: number;
  failed: number;
  note?: string;
}

export async function deliverDue(env: Env, at: Date): Promise<DeliveryTick> {
  const tick: DeliveryTick = { provider: provider(env), due: 0, sent: 0, failed: 0 };
  const site = siteUrl(env);
  if (tick.provider === 'none') return { ...tick, note: 'No email provider is configured.' };
  if (!site) return { ...tick, note: 'SITE_URL is not set.' };

  // People who signed up before sending was configured never got a confirmation: send it now.
  const waiting = await env.DB.prepare(
    `SELECT email, lang FROM subscribers s WHERE status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM email_log l WHERE l.email = s.email AND l.kind = 'confirm' AND l.status IN ('sending', 'sent', 'failed'))
     LIMIT ${CONFIRM_BACKLOG_PER_TICK}`,
  ).all<{ email: string; lang: Lang }>();
  for (const w of waiting.results) await sendLinkEmail(env, 'confirm', w.email, w.lang, site);

  const { results } = await env.DB.prepare("SELECT email, lang, timezone FROM subscribers WHERE status = 'confirmed'").all<Subscriber>();
  let budget = MAX_PER_TICK;
  for (const [date, group] of dueByDate(results, at)) {
    if (budget <= 0) break;
    const row = await env.DB.prepare("SELECT data FROM issues WHERE date = ? AND status = 'published'").bind(date).first<{ data: string }>();
    if (!row) continue;
    const claimed = new Set(await claim(env, date, group.slice(0, budget).map((s) => s.email)));
    if (claimed.size === 0) continue;
    budget -= claimed.size;
    tick.due += claimed.size;
    const issue = JSON.parse(row.data) as Issue;
    for (const lang of ['en', 'zh'] as const) {
      const recipients = group.filter((s) => s.lang === lang && claimed.has(s.email));
      if (recipients.length === 0) continue;
      const rendered = renderIssueEmail(issue, lang, site, env.EMAIL_POSTAL_ADDRESS);
      for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const mails = await Promise.all(recipients.slice(i, i + BATCH_SIZE).map((s) => personalise(env, site, lang, s.email, rendered)));
        const sent = await sendBatch(env, mails, `aiin5-issue-${date}-${lang}-${await digest(mails.map((m) => m.to).join(','))}`);
        await settle(env, 'issue', date, sent);
        tick.sent += sent.filter((r) => r.ok).length;
        tick.failed += sent.filter((r) => !r.ok).length;
      }
    }
  }
  return tick;
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type LinkKind = 'confirm' | 'signin';

/** At most one link email of a kind per address every 10 minutes, and 3 a day. */
async function maySend(env: Env, email: string, kind: LinkKind): Promise<boolean> {
  const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM email_log WHERE email = ? AND kind = ? AND created_at > ?')
    .bind(email, kind, day)
    .first<{ n: number; last: string | null }>();
  return (row?.n ?? 0) < 3 && !(row?.last && row.last > recent);
}

/**
 * Sends the double opt-in email, or a confirmed subscriber's sign-in link. Never throws:
 * a failure is logged in email_log only.
 */
export async function sendLinkEmail(env: Env, kind: LinkKind, email: string, lang: Lang, requestOrigin: string): Promise<void> {
  try {
    if (!(await maySend(env, email, kind))) return;
    const site = siteUrl(env, requestOrigin);
    const at = now();
    const ref = at;
    if (!site || provider(env) === 'none') {
      await env.DB.prepare("INSERT OR IGNORE INTO email_log (email, kind, ref, status, error, created_at, updated_at) VALUES (?, ?, ?, 'skipped', ?, ?, ?)")
        .bind(email, kind, ref, site ? 'No email provider is configured.' : 'SITE_URL is not set.', at, at)
        .run();
      return;
    }
    await env.DB.prepare("INSERT OR IGNORE INTO email_log (email, kind, ref, status, created_at, updated_at) VALUES (?, ?, ?, 'sending', ?, ?)").bind(email, kind, ref, at, at).run();
    const token = kind === 'confirm' ? await confirmToken(env, email) : await signInToken(env, email);
    const url = `${site}/${lang}/${kind}?t=${encodeURIComponent(token)}`;
    const rendered = kind === 'confirm' ? renderConfirmEmail(lang, url) : renderSignInEmail(lang, url, SIGNIN_MINUTES);
    const [result] = await sendBatch(env, [{ to: email, ...rendered }]);
    await settle(env, kind, ref, [result]);
  } catch (error) {
    console.error(`${kind} email failed`, safeErrorText(error instanceof Error ? error.message : error));
  }
}

/** From /admin: one issue to one address, to see it in a real inbox. */
export async function sendTest(env: Env, date: string, lang: Lang, to: string): Promise<{ ok: boolean; error?: string }> {
  const site = siteUrl(env);
  if (!site) return { ok: false, error: 'SITE_URL is not set.' };
  if (provider(env) === 'none') return { ok: false, error: 'No email provider is configured.' };
  const row = await env.DB.prepare('SELECT data FROM issues WHERE date = ?').bind(date).first<{ data: string }>();
  if (!row) return { ok: false, error: 'No issue for that date.' };
  const mail = await personalise(env, site, lang, to, renderIssueEmail(JSON.parse(row.data) as Issue, lang, site, env.EMAIL_POSTAL_ADDRESS));
  const at = now();
  await env.DB.prepare("INSERT OR IGNORE INTO email_log (email, kind, ref, status, created_at, updated_at) VALUES (?, 'test', ?, 'sending', ?, ?)").bind(to, at, at, at).run();
  const [result] = await sendBatch(env, [{ ...mail, subject: `[Test] ${mail.subject}` }]);
  await settle(env, 'test', at, [result]);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** The admin's view: counts only, never addresses. */
export async function emailStatus(env: Env): Promise<{
  provider: string;
  from: string | null;
  siteUrl: string | null;
  subscribers: { status: string; lang: string; n: number }[];
  deliveries: { date: string; sent: number; failed: number; sending: number }[];
  lastError: string | null;
}> {
  const subscribers = await env.DB.prepare('SELECT status, lang, COUNT(*) AS n FROM subscribers GROUP BY status, lang ORDER BY status, lang').all<{ status: string; lang: string; n: number }>();
  const deliveries = await env.DB.prepare(
    `SELECT ref AS date, SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed, SUM(status = 'sending') AS sending
     FROM email_log WHERE kind = 'issue' GROUP BY ref ORDER BY ref DESC LIMIT 14`,
  ).all<{ date: string; sent: number; failed: number; sending: number }>();
  const error = await env.DB.prepare("SELECT error FROM email_log WHERE status IN ('failed', 'skipped') AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").first<{ error: string }>();
  return {
    provider: provider(env),
    from: (env.EMAIL_FROM ?? '').trim() || null,
    siteUrl: siteUrl(env),
    subscribers: subscribers.results,
    deliveries: deliveries.results,
    lastError: error?.error ?? null,
  };
}

/** The issue email as HTML, for the preview in /admin. */
export async function previewIssueEmail(env: Env, date: string, lang: Lang, requestOrigin: string): Promise<{ subject: string; html: string; bytes: number } | null> {
  const row = await env.DB.prepare('SELECT data FROM issues WHERE date = ?').bind(date).first<{ data: string }>();
  if (!row) return null;
  const site = siteUrl(env, requestOrigin) ?? requestOrigin;
  const rendered = renderIssueEmail(JSON.parse(row.data) as Issue, lang, site, env.EMAIL_POSTAL_ADDRESS);
  // The preview is nobody's copy: no unsubscribe token and no ask key.
  const html = rendered.html.split(UNSUBSCRIBE).join(`${site}/${lang}/unsubscribe`).split(`?k=${ASK_KEY}`).join('');
  return { subject: rendered.subject, html, bytes: new TextEncoder().encode(html).length };
}
