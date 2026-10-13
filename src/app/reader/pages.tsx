/** The reader's pages: an issue, the archive, How it's made, and the empty and error states. */

import { useCallback, useEffect, useState } from 'react';
import type { Issue, IssueResponse, IssueSummary, Lang } from '../../shared/issue';
import { withBase } from '../../shared/base';
import { COPY, REGION_NAMES, KIND_NAMES, dateParts, sep } from './i18n';
import StoryCard, { Logo } from './Story';
import AskSheet from './AskSheet';
import SubscribeForm from './Subscribe';
import { Link } from './Masthead';
import { confirmSubscription, fetchArchive, sendFeedback, unsubscribe } from './data';

export function Footer({ lang, sample }: { lang: Lang; sample?: boolean }) {
  const T = COPY[lang];
  return (
    <footer className="foot measure">
      <p>{T.footer}</p>
      <p className="foot-links">
        <Link to={`/${lang}/about`}>{T.how}</Link>
        <Link to={`/${lang}/about`}>{T.corrections}</Link>
        <Link to={`/${lang}/archive`}>{T.archive}</Link>
      </p>
      {sample && <p>{T.sample}</p>}
    </footer>
  );
}

function Done({ issue, prev, lang }: { issue: Issue; prev: string | null; lang: Lang }) {
  const T = COPY[lang];
  const [vote, setVote] = useState<'useful' | 'not_useful' | null>(null);
  const [shared, setShared] = useState(false);

  const onVote = (value: 'useful' | 'not_useful') => {
    if (vote) return;
    setVote(value);
    sendFeedback(issue.date, value).catch(() => setVote(null));
  };

  const onShare = async () => {
    const url = `${location.origin}${withBase(`/${lang}/${issue.date}`)}`;
    const title = `AI in 5 · ${dateParts(issue.date, lang).label}`;
    try {
      if (navigator.share) await navigator.share({ title, url });
      else {
        await navigator.clipboard.writeText(url);
        setShared(true);
      }
    } catch {
      /* the reader closed the share sheet */
    }
  };

  return (
    <section className="done measure" id="done">
      <p className="done-title">{T.doneTitle}</p>
      <p className="done-sub">{T.doneSub}</p>
      <div className="feedback">
        <p>{T.useful}</p>
        <div className="fb-btns">
          <button type="button" className="chip-btn" aria-pressed={vote === 'useful'} onClick={() => onVote('useful')}>
            {T.yes}
          </button>
          <button type="button" className="chip-btn" aria-pressed={vote === 'not_useful'} onClick={() => onVote('not_useful')}>
            {T.no}
          </button>
        </div>
        {vote && <p className="fb-thanks">{T.thanks}</p>}
      </div>
      <SubscribeForm lang={lang} source="done" label={T.subLabel} />
      <div className="done-links">
        <button type="button" className="text-btn" onClick={onShare}>
          {shared ? T.shared : T.share}
        </button>
        {prev && (
          <Link className="text-btn" to={`/${lang}/${prev}`}>
            {T.previous}
          </Link>
        )}
      </div>
    </section>
  );
}

function useProgress() {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      setProgress(max > 0 ? Math.min(100, (scrollY / max) * 100) : 0);
    };
    onScroll();
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);
  return progress;
}

export function IssuePage({ data, lang, story }: { data: IssueResponse & { issue: Issue }; lang: Lang; story: number | null }) {
  const T = COPY[lang];
  const { issue, prev } = data;
  const progress = useProgress();
  const [asking, setAsking] = useState<string | null>(null);
  const closeSheet = useCallback(() => setAsking(null), []);

  useEffect(() => {
    document.title = `AI in 5 · ${dateParts(issue.date, lang).label}`;
  }, [issue.date, lang]);

  useEffect(() => {
    if (!story) return;
    const target = issue.stories[story - 1];
    if (target) document.getElementById(`s-${target.id}`)?.scrollIntoView({ block: 'start', behavior: 'instant' });
    // "Ask about this story" in the email links here with #ask: open that story's sheet.
    if (target && location.hash === '#ask') setAsking(target.id);
  }, [issue, story]);

  const askingStory = issue.stories.find((s) => s.id === asking);

  return (
    <>
      <div className="progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
      {issue.today.length > 0 && (
        <section className="today page" aria-labelledby="t3">
          <div className="measure">
            <h2 className="label" id="t3">
              {T.todayIn(issue.today.length)}
            </h2>
            <ol className="t3">
              {issue.today.map((t) => (
                <li key={t.id}>
                  <a
                    href={`#s-${t.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById(`s-${t.id}`)?.scrollIntoView({ block: 'start' });
                    }}
                  >
                    {t.text[lang]}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
      <main className="page">
        {issue.stories.map((s) => (
          <StoryCard key={s.id} issue={issue} story={s} lang={lang} onAskOwn={setAsking} />
        ))}
        {issue.briefs.length > 0 && (
          <section className="briefs measure" aria-labelledby="ib">
            <h2 className="section-title" id="ib">
              {T.inBrief}
            </h2>
            <ul className="brief-list">
              {issue.briefs.map((b, i) => (
                <li className="brief" key={i}>
                  <p className="meta">
                    <Logo org={b.org} />
                    <span className="region">{REGION_NAMES[b.region][lang]}</span>
                    {b.kind === 'rumor' && <span className="rumor">{T.rumorTag}</span>}
                  </p>
                  <p className="brief-text">{b.text[lang]}</p>
                  <p className="brief-src">
                    {KIND_NAMES[b.kind][lang]}
                    {sep(lang)}
                    {b.src[lang]}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
        <Done issue={issue} prev={prev} lang={lang} />
        <Footer lang={lang} sample={issue.sample} />
      </main>
      {askingStory && <AskSheet issue={issue} story={askingStory} lang={lang} onClose={closeSheet} />}
    </>
  );
}

export function EmptyState({ lang }: { lang: Lang }) {
  const T = COPY[lang];
  return (
    <main className="page">
      <section className="plain measure">
        <h1>{T.emptyTitle}</h1>
        <p className="lead">{T.emptyText}</p>
        <SubscribeForm lang={lang} source="done" label={T.subLabel} />
      </section>
      <Footer lang={lang} />
    </main>
  );
}

export function Message({ lang, title, text, action }: { lang: Lang; title: string; text: string; action?: { label: string; onClick: () => void } }) {
  const T = COPY[lang];
  return (
    <main className="page">
      <section className="plain measure">
        <h1>{title}</h1>
        <p className="lead">{text}</p>
        {action ? (
          <button type="button" className="solid-btn" onClick={action.onClick}>
            {action.label}
          </button>
        ) : (
          <Link className="text-btn" to={`/${lang}/`}>
            {T.today}
          </Link>
        )}
      </section>
    </main>
  );
}

/**
 * The pages the email links open. Confirming happens on load. Unsubscribing waits for a
 * click, so a mail scanner that opens every link cannot unsubscribe anyone.
 */
export function EmailLinkPage({ lang, kind }: { lang: Lang; kind: 'confirm' | 'unsubscribe' }) {
  const T = COPY[lang];
  const token = new URLSearchParams(location.search).get('t') ?? '';
  const [state, setState] = useState<'ask' | 'working' | 'done' | 'failed'>(kind === 'confirm' ? 'working' : 'ask');

  useEffect(() => {
    document.title = `AI in 5 · ${kind === 'confirm' ? T.confirmedTitle : T.unsubTitle}`;
    if (kind !== 'confirm') return;
    if (!token) return setState('failed');
    confirmSubscription(token).then(
      () => setState('done'),
      () => setState('failed'),
    );
  }, [kind, token, T]);

  const leave = () => {
    setState('working');
    unsubscribe(token).then(
      () => setState('done'),
      () => setState('failed'),
    );
  };

  if (kind === 'confirm') {
    if (state === 'working') return <Message lang={lang} title={T.confirmWorking} text="" />;
    return state === 'done' ? <Message lang={lang} title={T.confirmedTitle} text={T.confirmedText} /> : <Message lang={lang} title={T.linkFailedTitle} text={T.confirmFailedText} />;
  }
  if (state === 'done') return <Message lang={lang} title={T.unsubDoneTitle} text={T.unsubDoneText} />;
  if (state === 'failed' || !token) return <Message lang={lang} title={T.linkFailedTitle} text={T.unsubFailedText} />;
  return (
    <main className="page">
      <section className="plain measure">
        <h1>{T.unsubTitle}</h1>
        <p className="lead">{T.unsubText}</p>
        <button type="button" className="solid-btn" disabled={state === 'working'} onClick={leave}>
          {T.unsubButton}
        </button>
      </section>
    </main>
  );
}

export function ArchivePage({ lang }: { lang: Lang }) {
  const T = COPY[lang];
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    document.title = `AI in 5 · ${T.archiveTitle}`;
    fetchArchive()
      .then((r) => setIssues(r.issues))
      .catch(() => setFailed(true));
  }, [T.archiveTitle]);
  return (
    <main className="page">
      <section className="plain measure">
        <h1>{T.archiveTitle}</h1>
        {failed && <p className="status-line">{T.loadFailed}</p>}
        {issues && issues.length === 0 && <p className="status-line">{T.emptyTitle}</p>}
        {issues && issues.length > 0 && (
          <ul className="archive-list">
            {issues.map((i) => (
              <li key={i.date}>
                <Link to={`/${lang}/${i.date}`}>
                  <span className="when">
                    {dateParts(i.date, lang).label}
                    <br />
                    {T.issueNumber(i.number)}
                  </span>
                  <span className="what">{i.headline[lang]}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Footer lang={lang} />
    </main>
  );
}

export function AboutPage({ lang }: { lang: Lang }) {
  const T = COPY[lang];
  useEffect(() => {
    document.title = `AI in 5 · ${T.aboutTitle}`;
  }, [T.aboutTitle]);
  return (
    <main className="page">
      <article className="plain measure">
        <h1>{T.aboutTitle}</h1>
        {T.about.map((section) => (
          <section key={section.heading}>
            <h2>{section.heading}</h2>
            {section.body.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </section>
        ))}
      </article>
      <Footer lang={lang} />
    </main>
  );
}
