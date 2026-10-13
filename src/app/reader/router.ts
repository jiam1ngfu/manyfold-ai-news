/**
 * The reader's routes, all language-prefixed so every language has its own URL:
 *   /                     → /en/ or /zh/ (saved choice, else the browser's language)
 *   /en/                  today's issue (newest on or before the reader's local date)
 *   /en/2026-10-12        one issue
 *   /en/2026-10-12/3      one issue, opened at its third story (share links)
 *   /en/archive           past issues
 *   /en/about             how it's made, corrections
 *   /en/confirm?t=…       the link in the confirmation email
 *   /en/signin?t=…        the link in the sign-in email (ask from another device)
 *   /en/unsubscribe?t=…   the unsubscribe link in every email
 * No router dependency: history.pushState plus a popstate listener. These paths are
 * written without the site's base path: navigate and Link add it, useRoute strips it.
 */

import { useEffect, useState } from 'react';
import type { Lang } from '../../shared/issue';
import { stripBase, withBase } from '../../shared/base';

export type Route =
  | { name: 'root' }
  | { name: 'today'; lang: Lang }
  | { name: 'issue'; lang: Lang; date: string; story: number | null }
  | { name: 'archive'; lang: Lang }
  | { name: 'about'; lang: Lang }
  | { name: 'confirm'; lang: Lang }
  | { name: 'signin'; lang: Lang }
  | { name: 'unsubscribe'; lang: Lang }
  | { name: 'notFound'; lang: Lang };

const LANG_KEY = 'aiin5.lang';

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'root' };
  const [first, second, third] = parts;
  if (first !== 'en' && first !== 'zh') return { name: 'notFound', lang: preferredLang() };
  const lang: Lang = first;
  if (!second) return { name: 'today', lang };
  if (second === 'archive' && !third) return { name: 'archive', lang };
  if (second === 'about' && !third) return { name: 'about', lang };
  if ((second === 'confirm' || second === 'signin' || second === 'unsubscribe') && !third) return { name: second, lang };
  if (/^\d{4}-\d{2}-\d{2}$/.test(second) && parts.length <= 3) {
    const story = third && /^\d{1,2}$/.test(third) ? Number(third) : null;
    if (third && story === null) return { name: 'notFound', lang };
    return { name: 'issue', lang, date: second, story };
  }
  return { name: 'notFound', lang };
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case 'root':
      return '/';
    case 'today':
      return `/${route.lang}/`;
    case 'issue':
      return `/${route.lang}/${route.date}${route.story ? `/${route.story}` : ''}`;
    case 'archive':
      return `/${route.lang}/archive`;
    case 'about':
      return `/${route.lang}/about`;
    case 'confirm':
    case 'signin':
    case 'unsubscribe':
      return `/${route.lang}/${route.name}`;
    case 'notFound':
      return `/${route.lang}/`;
  }
}

/** The same page in another language. */
export function withLang(route: Route, lang: Lang): string {
  if (route.name === 'root' || route.name === 'notFound') return `/${lang}/`;
  // The email links carry their token in the query; keep it when switching language.
  if (route.name === 'confirm' || route.name === 'signin' || route.name === 'unsubscribe') return `${pathFor({ ...route, lang })}${location.search}`;
  return pathFor({ ...route, lang });
}

export function preferredLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'en' || saved === 'zh') return saved;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((l) => l?.toLowerCase().startsWith('zh')) ? 'zh' : 'en';
}

export const rememberLang = (lang: Lang): void => localStorage.setItem(LANG_KEY, lang);

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', withBase(path));
  else history.pushState(null, '', withBase(path));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(stripBase(location.pathname)));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(stripBase(location.pathname)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}
