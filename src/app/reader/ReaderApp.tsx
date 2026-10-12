/**
 * The reader: AI in 5 as readers see it. Resolves the route, loads the issue, and sets
 * the page language. Typefaces load here (not in index.html) so the admin console at
 * /admin never downloads them.
 */

import { useEffect, useState } from 'react';
import type { Issue, IssueResponse, Lang } from '../../shared/issue';
import { COPY, localDate } from './i18n';
import Masthead from './Masthead';
import { AboutPage, ArchivePage, EmailLinkPage, EmptyState, IssuePage, Message } from './pages';
import { ReaderError, captureAskKey, fetchDraft, fetchIssue, fetchLatest } from './data';
import { navigate, pathFor, preferredLang, useRoute } from './router';
import './reader.css';

// Before the first render: an email link's ?k=… is stored and taken out of the address.
captureAskKey();

const FONTS =
  'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,200..800;1,6..72,200..800&family=Schibsted+Grotesk:wght@400..700&family=Noto+Serif+SC:wght@400;600&display=swap';

function loadFonts() {
  if (document.querySelector('link[data-reader-fonts]')) return;
  for (const href of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
    const pre = document.createElement('link');
    pre.rel = 'preconnect';
    pre.href = href;
    if (href.includes('gstatic')) pre.crossOrigin = '';
    document.head.append(pre);
  }
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = FONTS;
  css.dataset.readerFonts = '';
  document.head.append(css);
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; data: IssueResponse & { issue: Issue }; draft: boolean }
  | { state: 'empty' }
  | { state: 'missing' }
  | { state: 'failed' };

export default function ReaderApp() {
  const route = useRoute();
  const lang: Lang = route.name === 'root' ? preferredLang() : route.lang;
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(loadFonts, []);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
  }, [lang]);

  useEffect(() => {
    if (route.name === 'root') navigate(pathFor({ name: 'today', lang }), true);
  }, [route.name, lang]);

  const issueKey = route.name === 'today' ? 'today' : route.name === 'issue' ? route.date : null;
  const preview = route.name === 'issue' && new URLSearchParams(location.search).get('preview') === '1';

  useEffect(() => {
    if (!issueKey) return;
    let live = true;
    setLoad({ state: 'loading' });
    (issueKey === 'today' ? fetchLatest(localDate()) : preview ? fetchDraft(issueKey) : fetchIssue(issueKey))
      .then((data) => {
        if (!live) return;
        const draft = 'status' in data && data.status !== 'published';
        if (data.issue) setLoad({ state: 'ready', data: { ...data, issue: data.issue }, draft });
        else setLoad({ state: issueKey === 'today' ? 'empty' : 'missing' });
      })
      .catch((error) => {
        if (live) setLoad({ state: error instanceof ReaderError && error.status === 404 ? 'missing' : 'failed' });
      });
    return () => {
      live = false;
    };
  }, [issueKey, preview, attempt]);

  const T = COPY[lang];
  if (route.name === 'root') return null;

  if (route.name === 'archive' || route.name === 'about' || route.name === 'confirm' || route.name === 'unsubscribe' || route.name === 'notFound') {
    return (
      <>
        <Masthead lang={lang} route={route} />
        {route.name === 'archive' && <ArchivePage lang={lang} />}
        {route.name === 'about' && <AboutPage lang={lang} />}
        {(route.name === 'confirm' || route.name === 'unsubscribe') && <EmailLinkPage lang={lang} kind={route.name} />}
        {route.name === 'notFound' && <Message lang={lang} title={T.notFoundTitle} text={T.notFoundText} />}
      </>
    );
  }

  const issue = load.state === 'ready' ? load.data.issue : null;
  return (
    <>
      {load.state === 'ready' && load.draft && (
        <p className="preview-banner" role="status">
          Draft preview. Readers can’t see this issue until it is published in /admin.
        </p>
      )}
      <Masthead lang={lang} route={route} issue={issue} />
      {load.state === 'ready' && <IssuePage data={load.data} lang={lang} story={route.name === 'issue' ? route.story : null} />}
      {load.state === 'empty' && <EmptyState lang={lang} />}
      {load.state === 'missing' && <Message lang={lang} title={T.notFoundTitle} text={T.notFoundText} />}
      {load.state === 'failed' && (
        <Message lang={lang} title={T.loadFailed} text="" action={{ label: T.retry, onClick: () => setAttempt((a) => a + 1) }} />
      )}
    </>
  );
}
