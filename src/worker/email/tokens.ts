/**
 * Signed tokens for the links in our emails: confirm a subscription, sign in on another
 * device, unsubscribe, and the ask key a subscriber's browser keeps to ask their own
 * questions. Nothing is stored per link; the token carries the address and an
 * HMAC-SHA256 tag.
 *
 * The signing key is its own random value in `settings`, deliberately separate from
 * CONFIG_ENCRYPTION_KEY: an unsubscribe link in an email sent months ago must keep
 * working even if the owner sets or rotates that secret later.
 */

import type { Env } from '../types';
import { getSetting, setSettingIfAbsent } from '../db';
import { safeEqual } from '../crypto';

const KEY_SETTING = 'link_signing_key';
const enc = new TextEncoder();
const dec = new TextDecoder();

export type TokenKind = 'confirm' | 'signin' | 'unsubscribe' | 'ask';

const CODE: Record<TokenKind, string> = { confirm: 'c', signin: 's', unsubscribe: 'u', ask: 'a' };

export interface TokenPayload {
  kind: TokenKind;
  email: string;
  /** Expiry, seconds since the epoch. Unsubscribe links and ask keys never expire. */
  exp?: number;
}

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64url = (value: string): Uint8Array => {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

export async function importSigningKey(material: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`aiin5-email-links:${material}`));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

let cached: { material: string; key: CryptoKey } | null = null;

async function signingKey(env: Env): Promise<CryptoKey> {
  let material = await getSetting(env, KEY_SETTING);
  if (!material) {
    await setSettingIfAbsent(env, KEY_SETTING, b64url(crypto.getRandomValues(new Uint8Array(32))));
    material = (await getSetting(env, KEY_SETTING)) ?? '';
  }
  if (cached?.material !== material) cached = { material, key: await importSigningKey(material) };
  return cached.key;
}

// A 128-bit tag is plenty for a link and keeps URLs short.
const tag = async (key: CryptoKey, body: string): Promise<string> =>
  b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body))).slice(0, 16));

export async function signWith(key: CryptoKey, payload: TokenPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ k: CODE[payload.kind], e: payload.email, ...(payload.exp ? { x: payload.exp } : {}) })));
  return `${body}.${await tag(key, body)}`;
}

export async function verifyWith(key: CryptoKey, token: string, kind: TokenKind, now = Date.now()): Promise<string | null> {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqual(await tag(key, body), sig)) return null;
  try {
    const data = JSON.parse(dec.decode(fromB64url(body))) as { k?: string; e?: unknown; x?: unknown };
    if (data.k !== CODE[kind] || typeof data.e !== 'string') return null;
    if (typeof data.x === 'number' && data.x * 1000 < now) return null;
    return data.e;
  } catch {
    return null;
  }
}

const CONFIRM_DAYS = 14;

export const confirmToken = async (env: Env, email: string): Promise<string> =>
  signWith(await signingKey(env), { kind: 'confirm', email, exp: Math.floor(Date.now() / 1000) + CONFIRM_DAYS * 86400 });

export const SIGNIN_MINUTES = 30;

/** Short-lived: it is traded once for an ask key, on the device the reader opens it on. */
export const signInToken = async (env: Env, email: string): Promise<string> =>
  signWith(await signingKey(env), { kind: 'signin', email, exp: Math.floor(Date.now() / 1000) + SIGNIN_MINUTES * 60 });

export const unsubscribeToken = async (env: Env, email: string): Promise<string> => signWith(await signingKey(env), { kind: 'unsubscribe', email });

/** Lets a confirmed subscriber's browser ask questions; checked against their status on every use. */
export const askToken = async (env: Env, email: string): Promise<string> => signWith(await signingKey(env), { kind: 'ask', email });

export const verifyToken = async (env: Env, token: string, kind: TokenKind): Promise<string | null> => verifyWith(await signingKey(env), token, kind);
