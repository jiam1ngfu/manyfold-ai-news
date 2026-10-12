/**
 * The reader's write routes: subscribe (with its confirm and unsubscribe links), "was
 * this useful", and "report a problem". They are open to the public (no admin
 * password), so each one validates strictly and is throttled per client. A client is a
 * salted SHA-256 of the connecting IP; the IP itself is never stored.
 *
 * Subscribing never reveals whether an address was already on the list: the answer is
 * the same either way, and only a pending address gets a (rate-limited) confirmation.
 */

import { LANGS, type Lang } from '../shared/issue';
import { HttpError, type Env } from './types';
import { getSetting, now, setSettingIfAbsent } from './db';
import { verifyToken } from './email/tokens';

type Body = Record<string, unknown> | null;

const SALT_KEY = 'client_hash_salt';

async function salt(env: Env): Promise<string> {
  const existing = await getSetting(env, SALT_KEY);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  await setSettingIfAbsent(env, SALT_KEY, Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
  return (await getSetting(env, SALT_KEY)) ?? '';
}

export async function clientKey(env: Env, ip: string | undefined): Promise<string> {
  const data = new TextEncoder().encode(`${await salt(env)}:${ip ?? 'unknown'}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** At most `limit` requests per client per hour for this bucket. */
async function throttle(env: Env, bucket: string, client: string, limit: number): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND client = ? AND created_at > ?')
    .bind(bucket, client, since)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= limit) throw new HttpError(429, 'too_many_requests', 'Too many requests. Try again later.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO rate_events (bucket, client, created_at) VALUES (?, ?, ?)').bind(bucket, client, now()),
    env.DB.prepare('DELETE FROM rate_events WHERE created_at < ?').bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
  ]);
}

function lang(value: unknown): Lang {
  if (typeof value !== 'string' || !LANGS.includes(value as Lang)) throw new HttpError(400, 'bad_request', 'lang must be en or zh.');
  return value as Lang;
}

function issueDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'bad_request', 'date must be YYYY-MM-DD.');
  return value;
}

async function assertPublished(env: Env, date: string): Promise<void> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM issues WHERE date = ? AND status = 'published'").bind(date).first();
  if (!row) throw new HttpError(404, 'issue_not_found', 'There is no published issue for that date.');
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

export const isEmail = (value: string): boolean => value.length <= 254 && EMAIL.test(value);

/** Returns who needs a confirmation email, if anyone; the caller sends it after responding. */
export async function subscribe(env: Env, body: Body, client: string): Promise<{ email: string; lang: Lang } | null> {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isEmail(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
  const timezone = typeof body?.timezone === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(body.timezone) ? body.timezone : 'UTC';
  const source = body?.source === 'gate' ? 'gate' : 'done';
  const language = lang(body?.lang);
  await throttle(env, 'subscribe', client, 5);
  const at = now();
  // Someone who unsubscribed and signs up again starts over at pending.
  const row = await env.DB.prepare(
    `INSERT INTO subscribers (email, lang, timezone, status, source, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET lang = excluded.lang, timezone = excluded.timezone, updated_at = excluded.updated_at,
       status = CASE WHEN subscribers.status = 'unsubscribed' THEN 'pending' ELSE subscribers.status END
     RETURNING status`,
  )
    .bind(email, language, timezone, source, at, at)
    .first<{ status: string }>();
  return row?.status === 'pending' ? { email, lang: language } : null;
}

const token = (body: Body, query?: string | null): string => {
  const value = typeof body?.token === 'string' ? body.token : (query ?? '');
  if (!value || value.length > 600) throw new HttpError(400, 'bad_request', 'The link is incomplete.');
  return value;
};

/** The link in the confirmation email. */
export async function confirmSubscription(env: Env, body: Body, client: string): Promise<{ lang: Lang }> {
  await throttle(env, 'confirm', client, 30);
  const email = await verifyToken(env, token(body), 'confirm');
  if (!email) throw new HttpError(400, 'invalid_link', 'This confirmation link is invalid or has expired. Subscribe again to get a new one.');
  const row = await env.DB.prepare("UPDATE subscribers SET status = 'confirmed', updated_at = ? WHERE email = ? RETURNING lang").bind(now(), email).first<{ lang: Lang }>();
  if (!row) throw new HttpError(400, 'invalid_link', 'This address is not on the list any more. Subscribe again.');
  return { lang: row.lang };
}

/** The unsubscribe link and the one-click List-Unsubscribe header. Always succeeds for a valid link. */
export async function unsubscribe(env: Env, body: Body, query: string | null, client: string): Promise<void> {
  await throttle(env, 'unsubscribe', client, 30);
  const email = await verifyToken(env, token(body, query), 'unsubscribe');
  if (!email) throw new HttpError(400, 'invalid_link', 'This unsubscribe link is invalid. Reply to any issue and we will remove you by hand.');
  await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed', updated_at = ? WHERE email = ?").bind(now(), email).run();
}

export async function recordFeedback(env: Env, body: Body, client: string): Promise<void> {
  const date = issueDate(body?.date);
  const value = body?.value === 'useful' || body?.value === 'not_useful' ? body.value : null;
  if (!value) throw new HttpError(400, 'bad_request', 'value must be useful or not_useful.');
  await assertPublished(env, date);
  await throttle(env, 'feedback', client, 20);
  await env.DB.prepare('INSERT INTO feedback (issue_date, value, created_at) VALUES (?, ?, ?)').bind(date, value, now()).run();
}

export async function recordReport(env: Env, body: Body, client: string): Promise<void> {
  const date = issueDate(body?.date);
  const storyId = typeof body?.storyId === 'string' && /^[a-z0-9-]{1,60}$/.test(body.storyId) ? body.storyId : null;
  const target = typeof body?.target === 'string' && /^(story|answer|proof)(:\d{1,2})?$/.test(body.target) ? body.target : null;
  if (!storyId || !target) throw new HttpError(400, 'bad_request', 'storyId and target are required.');
  await assertPublished(env, date);
  await throttle(env, 'report', client, 20);
  await env.DB.prepare('INSERT INTO reports (issue_date, story_id, target, lang, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(date, storyId, target, lang(body?.lang), now())
    .run();
}
