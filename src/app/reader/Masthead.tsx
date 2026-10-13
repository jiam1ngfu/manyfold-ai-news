/**
 * The top of every reader page: the lockup, the language switch, and — on an issue —
 * the date, the reading time, and the dot map of where today's stories come from.
 */

import { useMemo, type MouseEvent, type ReactNode } from 'react';
import type { Issue, Lang, Place, RegionKey } from '../../shared/issue';
import { readingMinutes } from '../../shared/issue';
import { withBase } from '../../shared/base';
import Logo from '../components/Logo';
import { COPY, REGION_NAMES, dateParts } from './i18n';
import { navigate, rememberLang, withLang, type Route } from './router';
import { WORLD } from './world';

/** In-app link: plain <a href>, so it also works opened in a new tab. */
export function Link({ to, className, children, onNavigate, ...rest }: { to: string; className?: string; children: ReactNode; onNavigate?: () => void; 'aria-current'?: boolean }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate?.();
    navigate(to);
    window.scrollTo(0, 0);
  };
  return (
    <a href={withBase(to)} className={className} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}

const gx = (lon: number) => (lon + 180) / WORLD.step;
const gy = (lat: number) => (WORLD.top - lat) / WORLD.step;

function landPath(): string {
  let d = '';
  WORLD.rows.forEach((runs, r) => {
    runs.forEach(([start, len]) => {
      for (let c = start; c < start + len; c += 1) d += `M${c + 0.5} ${r + 0.5}h0`;
    });
  });
  return d;
}

let land: string | null = null;

function WorldMap({ places, label }: { places: Place[]; label: string }) {
  land ??= landPath();
  const pins = useMemo(() => {
    const seen = new Set<string>();
    return places.filter((p) => {
      const key = `${p.lon},${p.lat}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [places]);
  return (
    <svg className="world" viewBox={`0 0 ${360 / WORLD.step} ${WORLD.rows.length}`} role="img" aria-label={label}>
      <path d={land} stroke="#BEBBB3" strokeWidth={0.7} strokeLinecap="round" fill="none" />
      {pins.map((p) => (
        <circle key={`${p.lon},${p.lat}`} cx={gx(p.lon)} cy={gy(p.lat)} r={1.7} fill="#000" stroke="#fff" strokeWidth={0.6} />
      ))}
    </svg>
  );
}

function coverage(issue: Issue): [RegionKey, number][] {
  const counts = new Map<RegionKey, number>();
  [...issue.stories.map((s) => s.region), ...issue.briefs.map((b) => b.region)].forEach((r) => counts.set(r, (counts.get(r) ?? 0) + 1));
  return [...counts.entries()];
}

export default function Masthead({ lang, route, issue }: { lang: Lang; route: Route; issue?: Issue | null }) {
  const T = COPY[lang];
  const parts = issue ? dateParts(issue.date, lang) : null;
  const places = useMemo(() => (issue ? [...issue.stories.map((s) => s.place), ...issue.briefs.map((b) => b.place)] : []), [issue]);
  return (
    <header className="masthead page">
      <div className="topline">
        <Link to={`/${lang}/`} className="wordmark">
          <Logo height={27} />
        </Link>
        <nav className="langs" aria-label={T.languageLabel}>
          {(['en', 'zh'] as const).map((l) => (
            <Link key={l} to={withLang(route, l)} aria-current={l === lang} onNavigate={() => rememberLang(l)}>
              {l === 'en' ? 'EN' : '中文'}
            </Link>
          ))}
        </nav>
      </div>
      {issue && parts && (
        <>
          <h1 className="date">{parts.label}</h1>
          <p className="dek">{T.dek(parts.weekday, issue.stories.length + issue.briefs.length, readingMinutes(issue, lang))}</p>
          <WorldMap places={places} label={T.coverageLabel} />
          <ul className="coverage" aria-label={T.coverageLabel}>
            {coverage(issue).map(([region, n]) => (
              <li key={region}>
                <b>{REGION_NAMES[region][lang]}</b> {n}
              </li>
            ))}
          </ul>
        </>
      )}
    </header>
  );
}
