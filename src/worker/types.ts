/**
 * Worker-side types. `Env` mirrors the bindings and vars declared in wrangler.jsonc —
 * if you add a binding there, add it here too.
 */

export interface Env {
  /** Static build output in dist/client. Non-/api/ requests are served from here. */
  ASSETS: Fetcher;
  /** D1 database: issues, subscribers, runs, questions and the rest (src/worker/db.ts). */
  DB: D1Database;

  /** Manyfold API base, e.g. https://api.manyfold.ai */
  MANYFOLD_API_BASE_URL?: string;
  /** "production" enables https-only and private-IP checks on agent URLs. */
  ENVIRONMENT?: string;
  /** Optional: >=32 chars. Without it a key is generated and kept in D1. */
  CONFIG_ENCRYPTION_KEY?: string;
  /** Optional: when set, all routes except /api/health and /api/state require x-admin-password. */
  ADMIN_PASSWORD?: string;

  /** The public site, base path included, e.g. https://app.manyfold.ai/ai-news. Links in emails, share cards and the sitemap point here. */
  SITE_URL?: string;
  /** Sender, e.g. "AI in 5 <hello@aiin5.co>". Its domain must be verified with the provider. */
  EMAIL_FROM?: string;
  /** Secret. Resend API key; without it (or EMAIL_FROM) emails are logged, not sent. */
  RESEND_API_KEY?: string;
  /** The publisher's postal address, in every email footer (CAN-SPAM) and on the privacy page. */
  EMAIL_POSTAL_ADDRESS?: string;
  /** A mailbox a person reads: the Reply-To of every email and the privacy contact. */
  CONTACT_EMAIL?: string;
  /** Secret. Signs the bounce and complaint webhooks from Resend (whsec_…). Without it the webhook route is off. */
  RESEND_WEBHOOK_SECRET?: string;
  /** Where owner alerts go when none is set in /admin. */
  ALERT_EMAIL?: string;

  /** Cloudflare Turnstile on the subscribe form. Both or neither: without them the form has no challenge. */
  TURNSTILE_SITE_KEY?: string;
  /** Secret. */
  TURNSTILE_SECRET_KEY?: string;

  /** Readers' questions wait here for the answer agent (wrangler.jsonc queues). */
  ASK_QUEUE?: Queue<{ id: string; turn?: number }>;
}

/** Everything needed to talk to one agent over A2A. */
export interface AgentCredential {
  rpcUrl: string;
  token: string;
  /** Human-readable agent name, used in error messages. */
  label: string;
}

/** Errors that already know their HTTP shape. Thrown anywhere, mapped in index.ts. */
export class HttpError extends Error {
  // Plain fields rather than constructor parameter properties: keeps the class
  // friendly to any TS toolchain that only strips types.
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
