/**
 * The reader's calls to the public API, and the little bit of state it keeps in the
 * browser: whether this reader has subscribed, and the ask key that lets a confirmed
 * subscriber ask their own questions. No admin password is ever sent.
 */

import { useCallback, useEffect, useState } from 'react';
import type { CorrectionEntry, IssueResponse, IssueSummary, Lang, Quote } from '../../shared/issue';
import { withBase } from '../../shared/base';
import { getStoredPassword } from '../api';

export class ReaderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ReaderError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBase(path), {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ReaderError(response.status, body?.error?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const fetchLatest = (before: string) => request<IssueResponse>(`/api/issues/latest?before=${encodeURIComponent(before)}`);
export const fetchIssue = (date: string) => request<IssueResponse>(`/api/issues/${encodeURIComponent(date)}`);
export const fetchArchive = () => request<{ issues: IssueSummary[] }>('/api/issues');
export const fetchCorrections = () => request<{ corrections: CorrectionEntry[] }>('/api/issues/corrections');

/**
 * The owner's draft preview (?preview=1). Uses the admin password the console keeps in
 * this tab's sessionStorage; readers never have one, so for them this simply fails.
 */
export const fetchDraft = (date: string) =>
  request<IssueResponse & { status: string }>(`/api/admin/issues/${encodeURIComponent(date)}`, {
    headers: { 'x-admin-password': getStoredPassword() },
  });

const post = (path: string, body: unknown) => request<{ ok: true }>(path, { method: 'POST', body: JSON.stringify(body) });

export const sendFeedback = (date: string, value: 'useful' | 'not_useful') => post('/api/feedback', { date, value });
export const sendReport = (date: string, storyId: string, target: string, lang: Lang, note = '') =>
  post('/api/reports', { date, storyId, target, lang, ...(note.trim() ? { note: note.trim() } : {}) });

/* ───────── reading counters ───────── */

let fromEmail = false;
const SEEN_KEY = 'aiin5.seen';

/** Issues this browser has opened, newest last: decides when to ask the survey question. */
export const seenIssues = (): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((d) => typeof d === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * Counts a view, a finish or a share of a published issue: totals per day, never per
 * person. A view by a subscriber's browser also carries its ask key, so the site knows a
 * subscriber opened this issue (stored as a salted hash). Each issue's view and finish
 * count once per visit. Failures are ignored: counting must never get in the way.
 */
export function sendEvent(event: 'view' | 'finish' | 'share', date: string, lang: Lang): void {
  if (event !== 'share') {
    const once = `aiin5.${event}.${date}`;
    if (sessionStorage.getItem(once)) return;
    sessionStorage.setItem(once, '1');
  }
  if (event === 'view') localStorage.setItem(SEEN_KEY, JSON.stringify([...seenIssues().filter((d) => d !== date), date].slice(-30)));
  const key = event === 'view' ? askKey() : null;
  post('/api/events', { event, date, lang, source: fromEmail ? 'email' : 'web', ...(key ? { key } : {}) }).catch(() => undefined);
}

/** Shares a page of ours: the share sheet where there is one, else the clipboard. */
export async function sharePage(path: string, title: string, date: string, lang: Lang): Promise<'shared' | 'copied' | null> {
  const url = `${location.origin}${withBase(path)}`;
  try {
    if (navigator.share) {
      await navigator.share({ title, url });
      sendEvent('share', date, lang);
      return 'shared';
    }
    await navigator.clipboard.writeText(url);
    sendEvent('share', date, lang);
    return 'copied';
  } catch {
    return null; // the reader closed the share sheet
  }
}

const SURVEY_KEY = 'aiin5.survey';
export const surveyAnswered = (): boolean => localStorage.getItem(SURVEY_KEY) !== null;
export const sendSurvey = (answer: 'very' | 'somewhat' | 'not') =>
  post('/api/survey', { key: askKey(), answer }).then(() => localStorage.setItem(SURVEY_KEY, answer));

const SUBSCRIBED_KEY = 'aiin5.subscribed';

/** `turnstile` is the bot check's token, when the site has the check on. */
export function subscribe(email: string, lang: Lang, source: 'done' | 'gate', turnstile: string | null = null) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return post('/api/subscribe', { email, lang, timezone, source, ...(turnstile ? { turnstile } : {}) }).then(() => {
    localStorage.setItem(SUBSCRIBED_KEY, '1');
    window.dispatchEvent(new Event('aiin5:subscribed'));
  });
}

const markSubscribed = (value: boolean) => {
  if (value) localStorage.setItem(SUBSCRIBED_KEY, '1');
  else localStorage.removeItem(SUBSCRIBED_KEY);
  window.dispatchEvent(new Event('aiin5:subscribed'));
};

const ASK_KEY = 'aiin5.askKey';

export const askKey = (): string | null => localStorage.getItem(ASK_KEY);

/**
 * Links in our emails carry the reader's ask key as ?k=…: keep it on this device, then
 * take it out of the address bar so it is not shared along with the page.
 */
export function captureAskKey(): void {
  const url = new URL(location.href);
  const key = url.searchParams.get('k');
  if (!key) return;
  // Only issue emails carry ?k= on their links: this visit came from one.
  fromEmail = true;
  if (key.length <= 600) {
    localStorage.setItem(ASK_KEY, key);
    markSubscribed(true);
  }
  url.searchParams.delete('k');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export const confirmSubscription = (token: string) =>
  request<{ ok: true; askKey?: string }>('/api/subscribe/confirm', { method: 'POST', body: JSON.stringify({ token }) }).then((r) => {
    if (r.askKey) localStorage.setItem(ASK_KEY, r.askKey);
    markSubscribed(true);
  });
export const signIn = (token: string) =>
  request<{ ok: true; askKey: string }>('/api/subscribe/signin', { method: 'POST', body: JSON.stringify({ token }) }).then((r) => {
    localStorage.setItem(ASK_KEY, r.askKey);
    markSubscribed(true);
  });
/** Forgets the ask key on this device only; the subscription is untouched. */
export const signOut = (): void => {
  localStorage.removeItem(ASK_KEY);
  markSubscribed(false);
};
/** With erase, the address and everything linked to it is deleted, not just unsubscribed. */
export const unsubscribe = (token: string, erase = false) =>
  post('/api/unsubscribe', { token, ...(erase ? { erase: true } : {}) }).then(() => {
    localStorage.removeItem(ASK_KEY);
    markSubscribed(false);
  });

export interface OwnAnswer {
  status: 'answered' | 'partial' | 'none';
  a: string;
  cites: Quote[];
}

export interface AskState {
  id: string;
  status: string;
  answer?: OwnAnswer;
  remaining?: number;
}

export const askQuestion = (date: string, storyId: string, lang: Lang, question: string) =>
  request<AskState>('/api/ask', { method: 'POST', body: JSON.stringify({ key: askKey(), date, storyId, lang, question }) });

/**
 * Polls until the answer is ready. Answers usually take 10 to 30 seconds, but a sleeping
 * answer agent can take minutes to wake, and the worker retries it twice, so keep going.
 */
export async function waitForAnswer(id: string, signal: AbortSignal): Promise<AskState> {
  const start = Date.now();
  while (Date.now() - start < 12 * 60_000) {
    const waited = Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, waited < 10_000 ? 2000 : waited < 60_000 ? 3000 : 5000));
    if (signal.aborted) throw new ReaderError(0, 'aborted');
    const state = await request<AskState>(`/api/ask/${encodeURIComponent(id)}`);
    if (state.status !== 'queued' && state.status !== 'answering') return state;
  }
  throw new ReaderError(504, 'timeout');
}

/**
 * Has this browser subscribed, and does it hold an ask key? Shared across the done
 * section and the ask sheet. Also follows other tabs, so a sheet left open here turns
 * into the question box as soon as the emailed link is opened in a new tab.
 */
export function useSubscribed(): { subscribed: boolean; hasKey: boolean } {
  const read = useCallback(() => ({ subscribed: localStorage.getItem(SUBSCRIBED_KEY) === '1', hasKey: Boolean(askKey()) }), []);
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    window.addEventListener('aiin5:subscribed', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('aiin5:subscribed', update);
      window.removeEventListener('storage', update);
    };
  }, [read]);
  return state;
}
