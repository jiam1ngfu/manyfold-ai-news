/**
 * Resend's webhook for bounces and spam complaints (POST /api/webhooks/resend): an
 * address that bounced for good, or whose owner marked us as spam, never gets another
 * email. Sending to dead or unwilling inboxes is what gets a domain's mail filtered.
 *
 * Resend signs webhooks the Svix way: HMAC-SHA256 over "id.timestamp.body" with the
 * base64 secret after "whsec_". Unsigned, stale or forged calls are rejected before the
 * body is read as JSON. The route is off until RESEND_WEBHOOK_SECRET is set.
 */

import type { Env } from '../types';
import { now } from '../db';
import { safeEqual } from '../crypto';
import { adminUrl, sendAlert } from '../alerts';

const TOLERANCE_S = 5 * 60;
const enc = new TextEncoder();

const fromB64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** True when the headers carry a valid, fresh signature of this exact body. */
export async function verifyWebhook(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, body: string, nowMs = Date.now()): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!secret.startsWith('whsec_') || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_S) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', fromB64(secret.slice('whsec_'.length)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    return false;
  }
  const expected = toB64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`))));
  return signature.split(' ').some((part) => {
    const [version, value] = part.split(',');
    return version === 'v1' && typeof value === 'string' && safeEqual(value, expected);
  });
}

type Outcome = 'bounced' | 'complained' | null;

/** What an event means for the recipient. A temporary bounce means nothing yet. */
export function outcomeOf(event: { type?: unknown; data?: { bounce?: { type?: unknown } } }): Outcome {
  if (event.type === 'email.complained') return 'complained';
  if (event.type !== 'email.bounced') return null;
  const kind = String(event.data?.bounce?.type ?? '');
  return /transient|temporary|undetermined/i.test(kind) ? null : 'bounced';
}

export async function handleResendWebhook(env: Env, request: Request): Promise<{ status: number; outcome?: Outcome }> {
  const secret = (env.RESEND_WEBHOOK_SECRET ?? '').trim();
  if (!secret) return { status: 404 };
  const body = await request.text();
  if (body.length > 100_000) return { status: 413 };
  const ok = await verifyWebhook(secret, { id: request.headers.get('svix-id'), timestamp: request.headers.get('svix-timestamp'), signature: request.headers.get('svix-signature') }, body);
  if (!ok) return { status: 401 };
  let event: { type?: unknown; data?: { to?: unknown; bounce?: { type?: unknown } } };
  try {
    event = JSON.parse(body);
  } catch {
    return { status: 400 };
  }
  const outcome = outcomeOf(event);
  if (!outcome) return { status: 200, outcome: null };
  const to = (Array.isArray(event.data?.to) ? event.data.to : [event.data?.to]).filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase());
  for (const email of to) {
    await env.DB.prepare("UPDATE subscribers SET status = ?, updated_at = ? WHERE email = ? AND status IN ('confirmed', 'pending')").bind(outcome, now(), email).run();
  }
  // One note a day is enough: the counts are in /admin#email. Never the address.
  await sendAlert(env, {
    key: `${outcome}:${now().slice(0, 10)}`,
    subject: outcome === 'complained' ? 'a subscriber marked an issue as spam' : 'an address bounced',
    lines: [
      outcome === 'complained'
        ? 'Someone marked an AI in 5 email as spam. They will not get another email. A few of these are normal; many mean something in the emails looks unwanted.'
        : 'An email bounced for good, so that address will not get another one. Further bounces today are counted in /admin without another alert.',
    ],
    link: { label: 'Open email stats', url: adminUrl(env, 'email') },
  });
  return { status: 200, outcome };
}
