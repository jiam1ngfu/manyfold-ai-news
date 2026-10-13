/**
 * Emails to the owner when something needs a person: the daily run failed, an issue was
 * published (or is waiting as a draft), a reader reported a problem, or emails bounced.
 * The pipeline publishes on its own, so these are how the owner keeps watch.
 *
 * Each alert has a key ("failed:2026-10-14-1"); it is claimed in email_log before the
 * send, so a retried cron never sends it twice. Readers' reports are capped on their own
 * (MAX_REPORTS_PER_DAY), so a flood of them cannot use up the day's MAX_PER_DAY and hide a
 * failed run. Alerts never carry a subscriber's address. They never throw: a failed alert
 * is logged and forgotten.
 */

import type { Env } from './types';
import { getSetting, now, setSetting } from './db';
import { safeErrorText } from './a2a';
import { esc } from './email/render';
import { provider, sendBatch } from './email/send';

export const ALERT_EMAIL_KEY = 'alert_email';
const MAX_PER_DAY = 30;
const MAX_REPORTS_PER_DAY = 10;

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

/** The owner's address: set in /admin, else the ALERT_EMAIL variable. */
export async function alertAddress(env: Env): Promise<string | null> {
  const value = ((await getSetting(env, ALERT_EMAIL_KEY)) ?? env.ALERT_EMAIL ?? '').trim().toLowerCase();
  return EMAIL.test(value) ? value : null;
}

export async function setAlertAddress(env: Env, value: string): Promise<void> {
  const email = value.trim().toLowerCase();
  if (email && !EMAIL.test(email)) throw new Error('Enter a valid address, or leave it empty to turn alerts off.');
  await setSetting(env, ALERT_EMAIL_KEY, email);
}

export interface Alert {
  /** Dedupe key: one alert per key, ever. */
  key: string;
  subject: string;
  lines: string[];
  /** Where to act, e.g. /admin#issues. */
  link?: { label: string; url: string };
}

/** Sends one alert to the owner. Returns whether it went out. */
export async function sendAlert(env: Env, alert: Alert): Promise<boolean> {
  try {
    const to = await alertAddress(env);
    if (!to || provider(env) === 'none') return false;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(ref LIKE 'report:%') AS reports FROM email_log WHERE kind = 'alert' AND created_at > ?")
      .bind(since)
      .first<{ n: number; reports: number | null }>();
    if ((sent?.n ?? 0) >= MAX_PER_DAY) return false;
    if (alert.key.startsWith('report:') && (sent?.reports ?? 0) >= MAX_REPORTS_PER_DAY) return false;
    const at = now();
    const claimed = await env.DB.prepare("INSERT OR IGNORE INTO email_log (email, kind, ref, status, created_at, updated_at) VALUES (?, 'alert', ?, 'sending', ?, ?) RETURNING ref")
      .bind(to, alert.key, at, at)
      .first();
    if (!claimed) return false;
    const subject = `[AI in 5] ${alert.subject}`;
    const html = `<!doctype html><html><body style="margin:0;padding:20px;font:15px/1.55 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#000;">
${alert.lines.map((line) => `<p style="margin:0 0 10px;">${esc(line)}</p>`).join('\n')}
${alert.link ? `<p style="margin:16px 0 0;"><a href="${esc(alert.link.url)}" style="color:#0A5A39;font-weight:600;">${esc(alert.link.label)}</a></p>` : ''}
<p style="margin:24px 0 0;font-size:12px;color:#5F5E58;">Owner alert from AI in 5. Change or turn off alerts in /admin under Issues.</p>
</body></html>`;
    const text = [...alert.lines, ...(alert.link ? ['', `${alert.link.label}: ${alert.link.url}`] : []), '', 'Owner alert from AI in 5. Change or turn off alerts in /admin under Issues.'].join('\n');
    const [result] = await sendBatch(env, [{ to, subject, html, text }]);
    await env.DB.prepare("UPDATE email_log SET status = ?, error = ?, updated_at = ? WHERE email = ? AND kind = 'alert' AND ref = ?")
      .bind(result.ok ? 'sent' : 'failed', result.ok ? null : (result.error ?? 'Send failed.').slice(0, 300), now(), to, alert.key)
      .run();
    return result.ok;
  } catch (error) {
    console.error('alert failed', safeErrorText(error instanceof Error ? error.message : error));
    return false;
  }
}

/** Where the owner acts. SITE_URL includes the base path. */
export const adminUrl = (env: Env, hash: string): string => `${(env.SITE_URL ?? '').replace(/\/+$/, '')}/admin#${hash}`;
