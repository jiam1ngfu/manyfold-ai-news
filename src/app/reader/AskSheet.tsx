/**
 * "Ask about this story": a sheet scoped to one story (the ask sheet in docs/design).
 *
 * A confirmed subscriber whose browser holds an ask key types a question; the answer
 * comes back checked against the story's sources, usually in 10 to 30 seconds, and the
 * conversation stays for the rest of the visit. A subscriber without a key on this
 * device is told how to get one; everyone else sees the one-field gate. The story's
 * preset questions are always offered as a starting point.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AskPreset, Issue, Lang, Story } from '../../shared/issue';
import { COPY } from './i18n';
import { Answer, AskList } from './Story';
import SubscribeForm from './Subscribe';
import { ReaderError, askKey, askQuestion, useSubscribed, waitForAnswer, type OwnAnswer } from './data';

interface Entry {
  id: string | null;
  q: string;
  state: 'waiting' | 'done' | 'error';
  answer?: OwnAnswer;
  error?: string;
}

// The conversation per story outlives the sheet, so closing and reopening keeps it.
const threads = new Map<string, Entry[]>();
let remainingToday: number | null = null;

export default function AskSheet({ issue, story, lang, onClose }: { issue: Issue; story: Story; lang: Lang; onClose: () => void }) {
  const T = COPY[lang];
  const subscribed = useSubscribed();
  const hasKey = Boolean(askKey());
  const sheet = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const threadKey = `${issue.date}/${story.id}`;
  const [thread, setThread] = useState<Entry[]>(() => threads.get(threadKey) ?? []);
  const [question, setQuestion] = useState('');
  const [remaining, setRemaining] = useState<number | null>(remainingToday);
  const [blocked, setBlocked] = useState<string | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    sheet.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [thread]);

  const update = (entries: Entry[]) => {
    threads.set(threadKey, entries);
    setThread(entries);
  };

  const errorText = (cause: unknown): string => {
    if (cause instanceof ReaderError && cause.status === 429) return T.askLimit;
    if (cause instanceof ReaderError && cause.status === 503) return T.askPaused;
    return T.askFailed;
  };

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.replace(/\s+/g, ' ').trim();
    if (q.length < 3 || thread.some((t) => t.state === 'waiting')) return;
    setQuestion('');
    let entries = [...(threads.get(threadKey) ?? []), { id: null, q, state: 'waiting' as const }];
    update(entries);
    const settle = (patch: Partial<Entry>) => {
      entries = (threads.get(threadKey) ?? entries).map((t, i, all) => (i === all.length - 1 ? { ...t, ...patch } : t));
      update(entries);
    };
    try {
      const first = await askQuestion(issue.date, story.id, lang, q);
      if (first.remaining !== undefined) {
        remainingToday = first.remaining;
        setRemaining(first.remaining);
      }
      const final = first.answer ? first : await waitForAnswer(first.id, new AbortController().signal);
      if (final.answer) settle({ id: final.id, state: 'done', answer: final.answer });
      else settle({ id: final.id, state: 'error', error: T.askFailed });
    } catch (cause) {
      if (cause instanceof ReaderError && cause.status === 403) setBlocked(T.askNeedKey);
      if (cause instanceof ReaderError && cause.status === 429) {
        remainingToday = 0;
        setRemaining(0);
      }
      settle({ state: 'error', error: errorText(cause) });
    }
  };

  const asPreset = (q: string, answer: OwnAnswer): AskPreset => ({ status: answer.status, q: { en: q, zh: q }, a: { en: answer.a, zh: answer.a }, cites: answer.cites });
  const waiting = thread.some((t) => t.state === 'waiting');
  const canAsk = subscribed && hasKey && !blocked;

  return (
    <div className="sheet-root">
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={sheet}>
        <div className="handle" aria-hidden="true" />
        <div className="sheet-head">
          <p className="sheet-title" id="sheet-title">
            {T.sheetTitle}
          </p>
          <button type="button" className="text-btn" onClick={onClose}>
            {T.close}
          </button>
        </div>
        <p className="sheet-story">{story.title[lang]}</p>
        <p className="sheet-note">{T.sheetNote(story.sources.length)}</p>
        <div className="sheet-body" ref={body} aria-live="polite">
          {thread.map((t, k) => (
            <div key={k}>
              <p className="thread-q">{t.q}</p>
              {t.state === 'waiting' && (
                <div className="answer answering" role="status">
                  <p className="status">
                    <span className="dot pulse" aria-hidden="true" />
                    {T.answering}
                  </p>
                  <p className="answer-foot">{T.answeringHint}</p>
                </div>
              )}
              {t.state === 'done' && t.answer && (
                <Answer issue={issue} story={story} preset={asPreset(t.q, t.answer)} index={`own-${k}`} lang={lang} reportTarget={t.id ? `own:${t.id}` : undefined} />
              )}
              {t.state === 'error' && <p className="fine err">{t.error}</p>}
            </div>
          ))}
          {thread.length === 0 && story.ask.length > 0 && (
            <>
              {canAsk && <p className="soon">{T.askTry}</p>}
              <ul className="ask-list">
                <AskList issue={issue} story={story} lang={lang} idPrefix="sheet" />
              </ul>
            </>
          )}
        </div>
        {canAsk ? (
          <form className="sheet-form" onSubmit={ask}>
            <div className="row">
              <input
                type="text"
                name="q"
                maxLength={200}
                placeholder={T.askPlaceholder}
                aria-label={T.askPlaceholder}
                value={question}
                disabled={waiting || remaining === 0}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <button className="solid-btn" type="submit" disabled={waiting || remaining === 0 || question.trim().length < 3}>
                {T.askButton}
              </button>
            </div>
            <p className="quota">{remaining === null ? T.quotaDaily : T.quota(remaining)}</p>
          </form>
        ) : subscribed ? (
          <p className="gate">{blocked ?? T.askNeedKey}</p>
        ) : (
          <div className="gate">
            <p>{T.gateText}</p>
            <SubscribeForm lang={lang} source="gate" button={T.gateButton} className="gate-form" />
          </div>
        )}
      </div>
    </div>
  );
}
