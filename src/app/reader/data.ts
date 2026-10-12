/**
 * The reader's calls to the public API, and the little bit of state it keeps in the
 * browser: whether this reader has subscribed, and the ask key that lets a confirmed
 * subscriber ask their own questions. No admin password is ever sent.
 */

import { useCallback, useEffect, useState } from 'react';
import type { IssueResponse, IssueSummary, Lang, Quote } from '../../shared/issue';

export class ReaderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ReaderError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
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

/**
 * The owner's draft preview (?preview=1). Uses the admin password the console keeps in
 * this tab's sessionStorage; readers never have one, so for them this simply fails.
 */
export const fetchDraft = (date: string) =>
  request<IssueResponse & { status: string }>(`/api/admin/issues/${encodeURIComponent(date)}`, {
    headers: { 'x-admin-password': sessionStorage.getItem('adminPassword') ?? '' },
  });

const post = (path: string, body: unknown) => request<{ ok: true }>(path, { method: 'POST', body: JSON.stringify(body) });

export const sendFeedback = (date: string, value: 'useful' | 'not_useful') => post('/api/feedback', { date, value });
export const sendReport = (date: string, storyId: string, target: string, lang: Lang) =>
  post('/api/reports', { date, storyId, target, lang });

const SUBSCRIBED_KEY = 'aiin5.subscribed';

export function subscribe(email: string, lang: Lang, source: 'done' | 'gate') {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return post('/api/subscribe', { email, lang, timezone, source }).then(() => {
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
export const unsubscribe = (token: string) =>
  post('/api/unsubscribe', { token }).then(() => {
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

/** Polls until the answer is ready: answers usually take 10 to 30 seconds. */
export async function waitForAnswer(id: string, signal: AbortSignal): Promise<AskState> {
  for (let i = 0; i < 90; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, i < 5 ? 2000 : 3000));
    if (signal.aborted) throw new ReaderError(0, 'aborted');
    const state = await request<AskState>(`/api/ask/${encodeURIComponent(id)}`);
    if (state.status !== 'queued' && state.status !== 'answering') return state;
  }
  throw new ReaderError(504, 'timeout');
}

/** Has this browser subscribed? Shared across the done section and the ask sheet. */
export function useSubscribed(): boolean {
  const read = useCallback(() => localStorage.getItem(SUBSCRIBED_KEY) === '1', []);
  const [subscribed, setSubscribed] = useState(read);
  useEffect(() => {
    const update = () => setSubscribed(read());
    window.addEventListener('aiin5:subscribed', update);
    return () => window.removeEventListener('aiin5:subscribed', update);
  }, [read]);
  return subscribed;
}
