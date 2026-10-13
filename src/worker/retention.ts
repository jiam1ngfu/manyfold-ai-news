/**
 * How long personal data and source copies are kept, enforced once a day from the
 * 20:30 UTC cron, and a reader's own "delete my data". The privacy page
 * (src/app/reader/privacy.ts) promises exactly these periods: change both together.
 *
 *   subscribers who never confirmed, unsubscribed, bounced or complained   30 days
 *   email_log (who was sent what, for not sending twice)                  90 days
 *   readers' questions, and which issues a subscriber opened              90 days
 *   a subscriber's survey answer                                          deleted with the address
 *   source page copies (used to check quotes and answer questions)         90 days
 *   rate-limit events (salted IP hashes)                                    1 day (public.ts)
 *
 * Confirmed subscribers stay until they leave. Counts (daily_events, feedback, reports)
 * hold nothing about a person and are kept.
 */

import type { Env } from './types';
import { clientKey } from './public';

const DAY = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = { inactiveSubscriber: 30, emailLog: 90, questions: 90, reads: 90, snapshots: 90 } as const;

const before = (at: Date, days: number) => new Date(at.getTime() - days * DAY).toISOString();

export async function pruneOldData(env: Env, at = new Date()): Promise<Record<string, number>> {
  const inactive = before(at, RETENTION_DAYS.inactiveSubscriber);
  // Survey answers are keyed by the address's salted hash: drop those of the addresses going now.
  const leaving = await env.DB.prepare("SELECT email FROM subscribers WHERE status <> 'confirmed' AND updated_at < ? LIMIT 500").bind(inactive).all<{ email: string }>();
  const askers = await Promise.all(leaving.results.map((r) => clientKey(env, `ask:${r.email}`)));
  for (let i = 0; i < askers.length; i += 90) {
    const chunk = askers.slice(i, i + 90);
    await env.DB.prepare(`DELETE FROM survey WHERE asker IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk).run();
  }
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM email_log WHERE email IN (SELECT email FROM subscribers WHERE status <> 'confirmed' AND updated_at < ?)").bind(inactive),
    env.DB.prepare("DELETE FROM subscribers WHERE status <> 'confirmed' AND updated_at < ?").bind(inactive),
    env.DB.prepare('DELETE FROM email_log WHERE created_at < ?').bind(before(at, RETENTION_DAYS.emailLog)),
    env.DB.prepare('DELETE FROM questions WHERE created_at < ?').bind(before(at, RETENTION_DAYS.questions)),
    env.DB.prepare('DELETE FROM reads WHERE first_at < ?').bind(before(at, RETENTION_DAYS.reads)),
    env.DB.prepare('DELETE FROM source_snapshots WHERE fetched_at < ?').bind(before(at, RETENTION_DAYS.snapshots)),
  ]);
  const [, subscribers, emailLog, questions, reads, snapshots] = results.map((r) => r.meta.changes ?? 0);
  return { subscribers, emailLog, questions, reads, snapshots };
}

/**
 * Everything held about one address: the subscription, the send log, their questions,
 * which issues they opened and their survey answer. Asked for from the unsubscribe page,
 * so it needs only the signed link in their email.
 */
export async function eraseSubscriber(env: Env, email: string): Promise<void> {
  const asker = await clientKey(env, `ask:${email}`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM subscribers WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM email_log WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM questions WHERE asker = ?').bind(asker),
    env.DB.prepare('DELETE FROM reads WHERE asker = ?').bind(asker),
    env.DB.prepare('DELETE FROM survey WHERE asker = ?').bind(asker),
  ]);
}
