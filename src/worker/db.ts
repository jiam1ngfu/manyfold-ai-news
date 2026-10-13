/**
 * D1 access: the schema and the settings key/value store.
 *
 * The schema lives here as a string and is applied on the first request rather than
 * through migrations, because the "Deploy to Cloudflare" button provisions the database
 * but never runs a migration command — and because `npm run dev` should work with no
 * setup at all. Every statement is idempotent, so applying it repeatedly is free.
 *
 * This module deliberately imports nothing from crypto.ts: crypto.ts reads its key
 * material from `settings` through here, and one direction keeps that simple.
 */

import type { Env } from './types';

export const now = (): string => new Date().toISOString();

/* ───────── schema ───────── */

/**
 * Database schema. Add your own tables here — they are created on the next request.
 * Keep semicolons out of statement bodies: the splitter below treats every semicolon
 * as a statement boundary.
 */
const SCHEMA = `
-- Generic key/value store: the generated encryption and link-signing keys, and the
-- owner's settings (agents, automation, alerts).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One in-flight Manyfold authorization handshake. device_code_* is the only thing that
-- can redeem agent tokens, so it is stored encrypted and never leaves the server; the
-- browser only ever sees the row id.
CREATE TABLE IF NOT EXISTS connect_sessions (
  id             TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL,
  user_code      TEXT NOT NULL,
  auth_url       TEXT NOT NULL,
  device_code_ct TEXT NOT NULL,
  device_code_iv TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

-- Agents the user authorized. token_* is AES-GCM encrypted and never returned by the API.
CREATE TABLE IF NOT EXISTS agents (
  agent_id     TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  rpc_url      TEXT NOT NULL,
  card_url     TEXT,
  token_ct     TEXT NOT NULL,
  token_iv     TEXT NOT NULL,
  expires_at   TEXT,
  verified     INTEGER NOT NULL DEFAULT 0,
  warning      TEXT,
  connected_at TEXT NOT NULL
);

-- One conversation per agent. context_id / active_task_id give the agent multi-turn
-- memory across requests; both are cleared when the conversation is reset.
CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL UNIQUE,
  context_id     TEXT,
  active_task_id TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'complete',
  error           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, id);

-- One daily issue. data holds the full Issue JSON (src/shared/issue.ts), validated on
-- write. Only status = 'published' rows are ever served to readers.
CREATE TABLE IF NOT EXISTS issues (
  date         TEXT PRIMARY KEY,
  number       INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  data         TEXT NOT NULL,
  published_at TEXT,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_status_date ON issues (status, date);

-- Email subscribers. Personal data: never logged, never returned by the API.
-- status: pending (until the confirmation link is clicked), confirmed, unsubscribed,
-- bounced or complained (both reported by the mail provider; neither gets email again).
-- Rows that are not confirmed are deleted 30 days after their last change (retention.ts).
CREATE TABLE IF NOT EXISTS subscribers (
  email      TEXT PRIMARY KEY,
  lang       TEXT NOT NULL,
  timezone   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- "Was this issue useful?" from the done section.
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_date TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- "Report a problem" on a story, a checked number or an answer.
CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_date TEXT NOT NULL,
  story_id   TEXT NOT NULL,
  target     TEXT NOT NULL,
  lang       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

-- Throttle for the public write routes: one row per request, keyed by a salted IP hash.
CREATE TABLE IF NOT EXISTS rate_events (
  bucket     TEXT NOT NULL,
  client     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_events ON rate_events (bucket, client, created_at);

-- Text of each cited source page, kept so code can check quotes and numbers against it.
-- Internal only: never shown to readers.
CREATE TABLE IF NOT EXISTS source_snapshots (
  url        TEXT PRIMARY KEY,
  final_url  TEXT NOT NULL,
  title      TEXT NOT NULL,
  text       TEXT NOT NULL,
  image      TEXT,
  fetched_at TEXT NOT NULL
);

-- One row per pipeline run. id ("2026-10-12-1") seeds the A2A messageIds of its turns.
-- status: running, drafted or failed. report is the run report JSON.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id          TEXT PRIMARY KEY,
  issue_date  TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  status      TEXT NOT NULL,
  report      TEXT NOT NULL DEFAULT '{}',
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_date ON pipeline_runs (issue_date, started_at);

-- Every email we send or try to send. Personal data, like subscribers.
-- kind: issue (ref = issue date), confirm or test (ref = send time).
-- status: sending, sent, failed or skipped. The primary key is what stops a second copy
-- of the same issue: a recipient is claimed with INSERT OR IGNORE before sending.
CREATE TABLE IF NOT EXISTS email_log (
  email      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  status     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 1,
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (email, kind, ref)
);

CREATE INDEX IF NOT EXISTS idx_email_log_ref ON email_log (kind, ref, status);

-- Readers' own questions (src/worker/ask). id seeds the A2A messageId of its one turn.
-- asker is a salted hash of the subscriber's address, never the address itself.
-- status: queued, answering, answered, partial, none or failed. answer is the checked
-- answer JSON. cached_from points at the row whose answer was reused, costing nothing.
CREATE TABLE IF NOT EXISTS questions (
  id          TEXT PRIMARY KEY,
  issue_date  TEXT NOT NULL,
  story_id    TEXT NOT NULL,
  lang        TEXT NOT NULL,
  question    TEXT NOT NULL,
  norm        TEXT NOT NULL,
  asker       TEXT NOT NULL,
  status      TEXT NOT NULL,
  answer      TEXT,
  dropped     INTEGER NOT NULL DEFAULT 0,
  cached_from TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_cache ON questions (issue_date, story_id, lang, norm);
CREATE INDEX IF NOT EXISTS idx_questions_asker ON questions (asker, created_at);
CREATE INDEX IF NOT EXISTS idx_questions_created ON questions (created_at);

-- What the reader typed with "Report a problem", if anything. Untrusted text, shown in
-- /admin only. A side table because reports predates it and tables are never altered.
CREATE TABLE IF NOT EXISTS report_notes (
  report_id  INTEGER PRIMARY KEY,
  note       TEXT NOT NULL
);

-- The owner's check of a published issue during the trial and the weekly spot checks:
-- verdict clean (no factual errors found) or errors. Drives the launch gate in /admin.
CREATE TABLE IF NOT EXISTS issue_checks (
  issue_date TEXT PRIMARY KEY,
  verdict    TEXT NOT NULL,
  note       TEXT,
  checked_at TEXT NOT NULL
);

-- Reader events, counted per day and never per person: event is view, finish (reached
-- the end of the issue) or share. source is web or email (opened from an issue email).
CREATE TABLE IF NOT EXISTS daily_events (
  day        TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  event      TEXT NOT NULL,
  lang       TEXT NOT NULL,
  source     TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, issue_date, event, lang, source)
);

-- Which issues a confirmed subscriber opened, for the launch gate's "opened 3 of the
-- last 5" measure. asker is the same salted hash as in questions, never the address.
CREATE TABLE IF NOT EXISTS reads (
  asker      TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  first_at   TEXT NOT NULL,
  PRIMARY KEY (asker, issue_date)
);

-- "How would you feel if AI in 5 stopped?", one answer per subscriber (salted hash):
-- very, somewhat or not (disappointed).
CREATE TABLE IF NOT EXISTS survey (
  asker      TEXT PRIMARY KEY,
  answer     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Split SQL into statements: drop `--` comments first, then split on ';'.
 * Comments go first because they are allowed to contain punctuation that would
 * otherwise split a statement in half. Statement bodies are not.
 */
export function schemaStatements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

let initialized: Promise<void> | null = null;

/** Idempotent; runs at most once per isolate, and retries on the next request if it fails. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!initialized) {
    initialized = db
      .batch(schemaStatements(SCHEMA).map((statement) => db.prepare(statement)))
      .then(() => undefined)
      .catch((error) => {
        initialized = null;
        throw error;
      });
  }
  return initialized;
}

/* ───────── settings ───────── */

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now())
    .run();
}

/** Writes only if the key is unset. Used for the generated encryption key, where
 *  concurrent first requests must converge on a single winner. */
export async function setSettingIfAbsent(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(key, value, now())
    .run();
}
