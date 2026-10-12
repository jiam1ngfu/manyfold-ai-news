/**
 * The one place that talks to an email provider. Today that is Resend's batch API;
 * swapping to another provider means rewriting only this file.
 *
 * Without RESEND_API_KEY and EMAIL_FROM the provider is "none": nothing leaves the
 * Worker, callers record the email as skipped, and /admin says what is missing.
 */

import type { Env } from '../types';
import { fetchTimeout, safeErrorText } from '../a2a';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  to: string;
  ok: boolean;
  error?: string;
}

export type Provider = 'resend' | 'none';

export const provider = (env: Env): Provider => ((env.RESEND_API_KEY ?? '').trim() && (env.EMAIL_FROM ?? '').trim() ? 'resend' : 'none');

const RESEND_BATCH = 'https://api.resend.com/emails/batch';
export const BATCH_SIZE = 100;
const TIMEOUT_MS = 20_000;

/** Sends up to BATCH_SIZE emails in one request. A failed request fails the whole batch. */
export async function sendBatch(env: Env, mails: Mail[], idempotencyKey?: string): Promise<SendResult[]> {
  if (mails.length === 0) return [];
  if (mails.length > BATCH_SIZE) throw new Error(`At most ${BATCH_SIZE} emails per batch.`);
  if (provider(env) === 'none') return mails.map((m) => ({ to: m.to, ok: false, error: 'No email provider is configured.' }));
  const from = (env.EMAIL_FROM ?? '').trim();
  try {
    const response = await fetchTimeout(
      RESEND_BATCH,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${(env.RESEND_API_KEY ?? '').trim()}`,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify(mails.map((m) => ({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(m.headers ? { headers: m.headers } : {}) }))),
      },
      TIMEOUT_MS,
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      const error = safeErrorText(`Resend answered HTTP ${response.status}${body?.message ? `: ${body.message}` : ''}`);
      return mails.map((m) => ({ to: m.to, ok: false, error }));
    }
    return mails.map((m) => ({ to: m.to, ok: true }));
  } catch (error) {
    const message = safeErrorText(error instanceof Error ? error.message : error);
    return mails.map((m) => ({ to: m.to, ok: false, error: message }));
  }
}
