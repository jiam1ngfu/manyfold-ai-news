/**
 * Cloudflare Turnstile on the subscribe form: a subscription sends an email to whatever
 * address is typed, so a script must not be able to send our mail to strangers. On only
 * when both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set; local development and
 * the tests run without it.
 */

import { HttpError, type Env } from './types';
import { fetchTimeout } from './a2a';

const VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const turnstileOn = (env: Env): boolean => Boolean((env.TURNSTILE_SITE_KEY ?? '').trim() && (env.TURNSTILE_SECRET_KEY ?? '').trim());

export async function assertHuman(env: Env, token: unknown, ip: string | undefined): Promise<void> {
  if (!turnstileOn(env)) return;
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    throw new HttpError(400, 'challenge_required', 'Please complete the check and try again.');
  }
  const form = new FormData();
  form.append('secret', (env.TURNSTILE_SECRET_KEY ?? '').trim());
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  let outcome: { success?: boolean } | null = null;
  try {
    const response = await fetchTimeout(VERIFY, { method: 'POST', body: form }, 10_000);
    outcome = (await response.json()) as { success?: boolean };
  } catch {
    throw new HttpError(503, 'challenge_unavailable', 'We could not check that just now. Try again in a minute.');
  }
  if (!outcome?.success) throw new HttpError(400, 'challenge_failed', 'The check did not pass. Reload the page and try again.');
}
