/**
 * The one-field email form, used on the done section, the ask sheet and the empty state.
 * It is also how a subscriber gets a sign-in link on a new device: the server decides
 * which email to send, and the page says the same thing either way. A Turnstile check
 * starts when the reader starts typing (turnstile.ts) and is invisible unless needed.
 */

import { useId, useState, type FormEvent } from 'react';
import type { Lang } from '../../shared/issue';
import { COPY } from './i18n';
import { ReaderError, subscribe, useSubscribed } from './data';
import { Link } from './Masthead';
import { useTurnstile } from './turnstile';

export default function SubscribeForm({
  lang,
  source,
  label,
  button,
  fine,
  className = 'subscribe',
}: {
  lang: Lang;
  source: 'done' | 'gate';
  label?: string;
  button?: string;
  fine?: string;
  className?: string;
}) {
  const T = COPY[lang];
  const id = useId();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error' | 'check'>('idle');
  const { subscribed, hasKey } = useSubscribed();
  const check = useTurnstile(lang);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setState('sending');
    try {
      await subscribe(email, lang, source, await check.token());
      setState('done');
    } catch (error) {
      setState(error instanceof ReaderError && error.status === 400 && check.on ? 'check' : 'error');
    } finally {
      check.reset();
    }
  };

  // Only a confirmed subscriber's browser holds an ask key. One that subscribed here but
  // has no key yet keeps the form, in case the email never came or was opened elsewhere.
  if (state === 'done' || (hasKey && state === 'idle')) {
    return (
      <div className={className}>
        <p className="fine ok" role="status">
          {state === 'done' ? T.subDone : T.subConfirmed}
        </p>
      </div>
    );
  }
  const failed = state === 'error' || state === 'check';
  return (
    <form className={className} onSubmit={onSubmit}>
      {label && <label htmlFor={id}>{label}</label>}
      <div className="row">
        <input
          id={id}
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          aria-label={label ? undefined : 'Email'}
          required
          value={email}
          onFocus={check.start}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="solid-btn" type="submit" disabled={state === 'sending'}>
          {button ?? T.subButton}
        </button>
      </div>
      {check.on && <div className="turnstile" ref={check.container} />}
      <p className={failed ? 'fine err' : 'fine'} role={failed ? 'alert' : undefined}>
        {state === 'check' ? T.subCheck : state === 'error' ? T.subFailed : subscribed ? T.subAgain : (fine ?? T.subFine)}{' '}
        {!failed && (
          <Link to={`/${lang}/privacy`} className="fine-link">
            {T.privacy}
          </Link>
        )}
      </p>
    </form>
  );
}
