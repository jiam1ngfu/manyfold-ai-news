/**
 * The site lives under one path of a shared host (https://app.manyfold.ai/ai-news), so
 * every page, API call and static file is addressed below BASE_PATH. Routes, both the
 * worker's and the reader's, are written without it: withBase adds it on the way out,
 * stripBase removes it on the way in, and a path that lacks it passes through unchanged.
 */

export const BASE_PATH = '/ai-news';

/** `/api/state` → `/ai-news/api/state`. */
export const withBase = (path: string): string => `${BASE_PATH}${path}`;

/** `/ai-news/en/` → `/en/`, `/ai-news` → `/`. */
export function stripBase(pathname: string): string {
  if (pathname === BASE_PATH) return '/';
  return pathname.startsWith(`${BASE_PATH}/`) ? pathname.slice(BASE_PATH.length) : pathname;
}
