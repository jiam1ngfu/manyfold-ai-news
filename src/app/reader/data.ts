/**
 * The reader's calls to the public API, and the little bit of state it keeps in the
 * browser (whether this reader has subscribed). No admin password is ever sent.
 */

import { useCallback, useEffect, useState } from 'react';
import type { IssueResponse, IssueSummary, Lang } from '../../shared/issue';

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

export const confirmSubscription = (token: string) => post('/api/subscribe/confirm', { token }).then(() => markSubscribed(true));
export const unsubscribe = (token: string) => post('/api/unsubscribe', { token }).then(() => markSubscribed(false));

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
