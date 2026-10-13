/**
 * Cloudflare Turnstile for the subscribe form. The server puts the site key in a meta tag
 * (src/worker/pages.ts) only when the check is on, so without one this does nothing and
 * the form posts without a token. The script loads on first use, not with the page, and
 * the widget only shows itself when Cloudflare wants an interaction.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Lang } from '../../shared/issue';

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export const turnstileSiteKey = (): string | null => document.querySelector('meta[name="aiin5:turnstile"]')?.getAttribute('content') || null;

let loading: Promise<TurnstileApi> | null = null;

function loadScript(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')));
    script.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * `start` renders the widget into `container` (call it when the reader starts typing),
 * `token` waits for a token (null when the check is off), `reset` gets a fresh one after
 * a submit, since each token works once.
 */
export function useTurnstile(lang: Lang) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const current = useRef<string | null>(null);
  const waiting = useRef<((token: string | null) => void)[]>([]);
  const siteKey = turnstileSiteKey();

  const settle = (token: string | null) => {
    current.current = token;
    if (token) waiting.current.splice(0).forEach((resolve) => resolve(token));
  };

  const start = useCallback(() => {
    if (!siteKey || widget.current || !container.current) return;
    widget.current = 'pending';
    loadScript().then(
      (api) => {
        if (!container.current) return;
        widget.current = api.render(container.current, {
          sitekey: siteKey,
          appearance: 'interaction-only',
          size: 'flexible',
          language: lang === 'zh' ? 'zh-cn' : 'en',
          callback: (token: string) => settle(token),
          'expired-callback': () => settle(null),
          'error-callback': () => settle(null),
        });
      },
      () => {
        widget.current = null;
      },
    );
  }, [siteKey, lang]);

  const token = useCallback(async (): Promise<string | null> => {
    if (!siteKey) return null;
    start();
    if (current.current) return current.current;
    return new Promise<string | null>((resolve) => {
      waiting.current.push(resolve);
      // Give up after a while; the server then answers that the check is needed.
      setTimeout(() => resolve(current.current), 20_000);
    });
  }, [siteKey, start]);

  const reset = useCallback(() => {
    current.current = null;
    if (widget.current && widget.current !== 'pending') window.turnstile?.reset(widget.current);
  }, []);

  useEffect(
    () => () => {
      if (widget.current && widget.current !== 'pending') window.turnstile?.remove(widget.current);
    },
    [],
  );

  return { container, start, token, reset, on: Boolean(siteKey) };
}
