/**
 * The admin console at /admin: loads /api/state once, routes between the tabs by
 * location.hash (/admin#issues, #email, #questions, #chat, #settings — no router dependency), and raises the
 * password gate whenever the deployment requires one and the stored password is
 * missing or wrong. Nothing in the reader links here.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppState } from '../shared/types';
import { api, onUnauthorized } from './api';
import ChatView from './components/ChatView';
import SettingsView from './components/SettingsView';
import PasswordGate from './components/PasswordGate';
import Logo from './components/Logo';
import IssuesView from './components/IssuesView';
import EmailView from './components/EmailView';
import QuestionsView from './components/QuestionsView';
import './styles.css';

type Tab = 'issues' | 'email' | 'questions' | 'chat' | 'settings';

const TABS: Tab[] = ['issues', 'email', 'questions', 'chat', 'settings'];
const tabFromHash = (): Tab => TABS.find((t) => location.hash === `#${t}`) ?? 'issues';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [gateOpen, setGateOpen] = useState(false);

  const refreshState = useCallback(async () => {
    try {
      const next = await api<AppState>('/api/state');
      setState(next);
      setLoadError('');
      setGateOpen(next.adminRequired && !next.adminOk);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    onUnauthorized(() => setGateOpen(true));
    void refreshState();
    return () => onUnauthorized(null);
  }, [refreshState]);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (loadError) {
    return (
      <main className="shell">
        <div className="notice error">
          Could not reach the API: {loadError}{' '}
          <button className="link" onClick={() => void refreshState()}>
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (!state) {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>
            <Logo />
          </h1>
          <p className="muted">Admin: issues, email, readers’ questions, connected agents, chat and settings.</p>
        </div>
        <nav className="tabs" aria-label="Pages">
          <a className={tab === 'issues' ? 'tab active' : 'tab'} href="#issues">
            Issues
          </a>
          <a className={tab === 'email' ? 'tab active' : 'tab'} href="#email">
            Email
          </a>
          <a className={tab === 'questions' ? 'tab active' : 'tab'} href="#questions">
            Questions
          </a>
          <a className={tab === 'chat' ? 'tab active' : 'tab'} href="#chat">
            Chat
          </a>
          <a className={tab === 'settings' ? 'tab active' : 'tab'} href="#settings">
            Settings
          </a>
        </nav>
      </header>

      {tab === 'issues' && <IssuesView agents={state.agents} />}
      {tab === 'email' && <EmailView />}
      {tab === 'questions' && <QuestionsView />}
      {tab === 'chat' && <ChatView agents={state.agents} initialSession={state.connect.session} refreshState={refreshState} />}
      {tab === 'settings' && <SettingsView agents={state.agents} initialSession={state.connect.session} refreshState={refreshState} />}

      {gateOpen && <PasswordGate onSubmitted={refreshState} />}
    </main>
  );
}
