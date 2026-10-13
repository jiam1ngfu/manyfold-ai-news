/** The reader's pages: an issue, the archive, How it's made, corrections, privacy, and the empty and error states. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { storyAt, type CorrectionEntry, type Issue, type IssueResponse, type IssueSummary, type Lang } from '../../shared/issue';
import { COPY, REGION_NAMES, KIND_NAMES, dateParts, sep } from './i18n';
import StoryCard, { Logo } from './Story';
import AskSheet from './AskSheet';
import SubscribeForm from './Subscribe';
import { Link } from './Masthead';
import { PRIVACY, PRIVACY_UPDATED } from './privacy';
import {
  confirmSubscription,
  fetchArchive,
  fetchCorrections,
  seenIssues,
  sendEvent,
  sendFeedback,
  sendSurvey,
  sharePage,
  signIn,
  surveyAnswered,
  unsubscribe,
  useSubscribed,
} from './data';

export function Footer({ lang, sample }: { lang: Lang; sample?: boolean }) {
  const T = COPY[lang];
  return (
    <footer className="foot measure">
      <p>{T.footer}</p>
      <p className="foot-links">
        <Link to={`/${lang}/about`}>{T.how}</Link>
        <Link to={`/${lang}/corrections`}>{T.corrections}</Link>
        <Link to={`/${lang}/archive`}>{T.archive}</Link>
        <Link to={`/${lang}/privacy`}>{T.privacy}</Link>
      </p>
      {sample && <p>{T.sample}</p>}
    </footer>
  );
}

/**
 * "How would you feel if you could no longer read AI in 5?" Asked once, of subscribers
 * whose browser has opened at least three issues: the launch gate's third measure.
 */
function Survey({ lang }: { lang: Lang }) {
  const T = COPY[lang];
  const { hasKey } = useSubscribed();
  const [answer, setAnswer] = useState<'very' | 'somewhat' | 'not' | null>(null);
  const [ask] = useState(() => !surveyAnswered() && seenIssues().length >= 3);
  if (!hasKey || !ask) return null;
  const choose = (value: 'very' | 'somewhat' | 'not') => {
    setAnswer(value);
    sendSurvey(value).catch(() => setAnswer(null));
  };
  return (
    <div className="feedback survey">
      <p>{T.survey}</p>
      <div className="fb-btns">
        {(['very', 'somewhat', 'not'] as const).map((value) => (
          <button key={value} type="button" className="chip-btn" aria-pressed={answer === value} disabled={answer !== null} onClick={() => choose(value)}>
            {T.surveyAnswers[value]}
          </button>
        ))}
      </div>
      {answer && <p className="fb-thanks">{T.surveyThanks}</p>}
    </div>
  );
}

function Done({ issue, prev, lang, live }: { issue: Issue; prev: string | null; lang: Lang; live: boolean }) {
  const T = COPY[lang];
  const [vote, setVote] = useState<'useful' | 'not_useful' | null>(null);
  const [shared, setShared] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // Reaching this section is finishing the issue.
  useEffect(() => {
    const el = ref.current;
    if (!el || !live || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        sendEvent('finish', issue.date, lang);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [issue.date, lang, live]);

  const onVote = (value: 'useful' | 'not_useful') => {
    if (vote) return;
    setVote(value);
    sendFeedback(issue.date, value).catch(() => setVote(null));
  };

  const onShare = async () => {
    const outcome = await sharePage(`/${lang}/${issue.date}`, `AI in 5 · ${dateParts(issue.date, lang).label}`, issue.date, lang);
    if (outcome === 'copied') setShared(true);
  };

  return (
    <section className="done measure" id="done" ref={ref}>
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
      {live && <Survey lang={lang} />}
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

export function IssuePage({ data, lang, story, live }: { data: IssueResponse & { issue: Issue }; lang: Lang; story: number | null; live: boolean }) {
  const T = COPY[lang];
  const { issue, prev } = data;
  const progress = useProgress();
  const [asking, setAsking] = useState<string | null>(null);
  const closeSheet = useCallback(() => setAsking(null), []);
  const withdrawn = (issue.corrections ?? []).filter((c) => c.kind === 'withdrawn');

  useEffect(() => {
    document.title = `AI in 5 · ${dateParts(issue.date, lang).label}`;
    // Drafts in the owner's preview are not counted.
    if (live) sendEvent('view', issue.date, lang);
  }, [issue.date, lang, live]);

  useEffect(() => {
    if (!story) return;
    // Positions are as published: a withdrawn story's link lands on its notice.
    const slot = storyAt(issue, story);
    if (slot && 'withdrawn' in slot) document.getElementById('wd')?.scrollIntoView({ block: 'start', behavior: 'instant' });
    const target = slot && 'story' in slot ? slot.story : null;
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
        {withdrawn.length > 0 && (
          <section className="briefs measure withdrawn" aria-labelledby="wd">
            <h2 className="section-title" id="wd">
              {T.withdrawnTitle}
            </h2>
            <ul className="brief-list">
              {withdrawn.map((c, i) => (
                <li className="brief" key={i}>
                  <p className="meta">
                    <span className="region">{T.withdrawn}</span>
                    <span>{dateParts(c.at.slice(0, 10), lang).label}</span>
                  </p>
                  <p className="brief-text">{c.title[lang].replace(/<\/?m\d+>/g, '')}</p>
                  <p className="brief-src">{c.note[lang]}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
        <Done issue={issue} prev={prev} lang={lang} live={live} />
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
 * The pages the email links open. Confirming and signing in happen on load. Unsubscribing
 * waits for a click, so a mail scanner that opens every link cannot unsubscribe anyone.
 */
export function EmailLinkPage({ lang, kind }: { lang: Lang; kind: 'confirm' | 'signin' | 'unsubscribe' }) {
  const T = COPY[lang];
  const token = new URLSearchParams(location.search).get('t') ?? '';
  const [state, setState] = useState<'ask' | 'working' | 'done' | 'erased' | 'failed'>(kind === 'unsubscribe' ? 'ask' : 'working');

  useEffect(() => {
    document.title = `AI in 5 · ${kind === 'confirm' ? T.confirmedTitle : kind === 'signin' ? T.signedInTitle : T.unsubTitle}`;
    if (kind === 'unsubscribe') return;
    if (!token) return setState('failed');
    (kind === 'confirm' ? confirmSubscription(token) : signIn(token)).then(
      () => setState('done'),
      () => setState('failed'),
    );
  }, [kind, token, T]);

  const leave = (erase: boolean) => {
    setState('working');
    unsubscribe(token, erase).then(
      () => setState(erase ? 'erased' : 'done'),
      () => setState('failed'),
    );
  };

  if (kind === 'confirm') {
    if (state === 'working') return <Message lang={lang} title={T.confirmWorking} text="" />;
    return state === 'done' ? <Message lang={lang} title={T.confirmedTitle} text={T.confirmedText} /> : <Message lang={lang} title={T.linkFailedTitle} text={T.confirmFailedText} />;
  }
  if (kind === 'signin') {
    if (state === 'working') return <Message lang={lang} title={T.signInWorking} text="" />;
    return state === 'done' ? <Message lang={lang} title={T.signedInTitle} text={T.signedInText} /> : <Message lang={lang} title={T.linkFailedTitle} text={T.signInFailedText} />;
  }
  if (state === 'done') return <Message lang={lang} title={T.unsubDoneTitle} text={T.unsubDoneText} />;
  if (state === 'erased') return <Message lang={lang} title={T.erasedTitle} text={T.erasedText} />;
  if (state === 'failed' || !token) return <Message lang={lang} title={T.linkFailedTitle} text={T.unsubFailedText} />;
  return (
    <main className="page">
      <section className="plain measure">
        <h1>{T.unsubTitle}</h1>
        <p className="lead">{T.unsubText}</p>
        <p className="row-btns">
          <button type="button" className="solid-btn" disabled={state === 'working'} onClick={() => leave(false)}>
            {T.unsubButton}
          </button>
          <button type="button" className="text-btn" disabled={state === 'working'} onClick={() => leave(true)}>
            {T.unsubErase}
          </button>
        </p>
        <p className="fine">
          {T.unsubEraseNote}{' '}
          <Link to={`/${lang}/privacy`}>{T.privacy}</Link>
        </p>
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

export function CorrectionsPage({ lang }: { lang: Lang }) {
  const T = COPY[lang];
  const [entries, setEntries] = useState<CorrectionEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    document.title = `AI in 5 · ${T.correctionsTitle}`;
    fetchCorrections()
      .then((r) => setEntries(r.corrections))
      .catch(() => setFailed(true));
  }, [T.correctionsTitle]);
  return (
    <main className="page">
      <section className="plain measure">
        <h1>{T.correctionsTitle}</h1>
        <p className="lead">{T.correctionsIntro}</p>
        {failed && <p className="status-line">{T.loadFailed}</p>}
        {entries && entries.length === 0 && <p className="status-line">{T.correctionsEmpty}</p>}
        {entries && entries.length > 0 && (
          <ul className="archive-list corrections-list">
            {entries.map((c, i) => (
              <li key={i}>
                <Link to={c.position ? `/${lang}/${c.date}/${c.position}` : `/${lang}/${c.date}`}>
                  <span className="when">
                    {dateParts(c.at.slice(0, 10), lang).label}
                    <br />
                    {c.kind === 'withdrawn' ? T.withdrawn : T.corrected}
                  </span>
                  <span className="what">
                    {c.title[lang].replace(/<\/?m\d+>/g, '')}
                    <span className="note">{c.note[lang]}</span>
                    <span className="note">
                      {dateParts(c.date, lang).label} · {T.issueNumber(c.number)}
                    </span>
                  </span>
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

export function PrivacyPage({ lang }: { lang: Lang }) {
  const T = COPY[lang];
  useEffect(() => {
    document.title = `AI in 5 · ${T.privacy}`;
  }, [T.privacy]);
  return (
    <main className="page">
      <article className="plain measure">
        <h1>{T.privacy}</h1>
        {PRIVACY[lang].map((section) => (
          <section key={section.heading}>
            <h2>{section.heading}</h2>
            {section.body.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </section>
        ))}
        <p className="fine">{PRIVACY_UPDATED[lang]}</p>
      </article>
      <Footer lang={lang} />
    </main>
  );
}
