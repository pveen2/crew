import { useEffect } from 'react';
import { useNavSwipe } from './swipe';
import { Banner, IconButton } from '@crew/ui';
import { isPhone, navigate, openExternal, openUrl, toggleNav, toggleSidebar, useApp, webApp } from './store';
import { Sidebar } from './components/Sidebar';
import { ServerLoginDialog } from './components/ServerLoginDialog';
import { ThreadView } from './components/ThreadView';
import { DocsView } from './components/DocsView';
import { InboxView } from './components/InboxView';
import { PaneErrorBoundary } from './components/PaneErrorBoundary';
import { AgentsView } from './components/AgentsView';
import { TeamView } from './components/TeamView';
import { SettingsView } from './components/SettingsView';
import { NewThreadView, ThreadsView } from './components/Screens';
import { DmView, NewMessageView } from './components/MessagesView';

export function App() {
  const view = useApp((s) => s.view);
  const connection = useApp((s) => s.connection);
  const startError = useApp((s) => s.conductorStartError);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const navOpen = useApp((s) => s.navOpen);
  const teamName = useApp((s) => s.teamName) || 'Crew';

  useEffect(() => window.crewHost?.onOpenUrl?.(openUrl), []);
  useNavSwipe();

  // The web app: a web link would replace the app in its own window (on an iPhone
  // there is no way back); open it in a new tab instead.
  useEffect(() => {
    if (window.crewHost) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!(a instanceof HTMLAnchorElement) || e.defaultPrevented) return;
      if (!/^https?:$/.test(a.protocol) || a.origin === location.origin) return;
      e.preventDefault();
      openExternal(a.href);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        navigate({ name: 'new' });
      }
      if (e.metaKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app cr-root ${window.crewHost ? 'in-electron' : 'in-browser'}${webApp ? ' web-app' : ''}${navOpen ? ' nav-open' : ''}`}>
      {/* Window title bar, as in Codex/ChatGPT: the traffic lights and the sidebar
          toggle share one row above everything, so the toggle never moves and the
          lights never crowd the sidebar or a pane. */}
      <header className="titlebar cr-drag">
        <span className="titlebar-lights" aria-hidden />
        <IconButton
          tone="dark"
          size="md"
          icon="sidebar"
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={`${collapsed ? 'Expand' : 'Collapse'} sidebar  ⌘B`}
          // On a phone the sidebar opens over the page instead of folding.
          onClick={() => (isPhone() ? toggleNav() : toggleSidebar())}
        />
        <span className="titlebar-team">{teamName}</span>
        <span className="cr-spacer" />
        <IconButton tone="dark" size="md" icon="plus" label="New thread" className="titlebar-new" onClick={() => navigate({ name: 'new' })} />
      </header>
      <ServerLoginDialog />
      <div className="app-body">
      <Sidebar />
      {/* Always there on a phone so it can fade in, and follow a swipe (swipe.ts). */}
      <div className={`nav-backdrop${navOpen ? ' nav-backdrop--open' : ''}`} aria-hidden onClick={() => toggleNav(false)} />
      <div className="workspace">
        {connection === 'offline' && (
          <Banner tone="caution" icon="wifiOff">
            {startError ?? (window.crewHost?.startConductor
              ? 'Can’t reach the conductor. You can start it from the sidebar.'
              : 'Can’t reach the conductor. Crew will reconnect when it’s available.')}
          </Banner>
        )}
        <div className="panes">
          {/* A fresh view per route (thread scroll, Inbox focus rely on it), except within Docs: picking
              another version keeps the pane, so the version picker keeps focus. */}
          <PaneErrorBoundary key={view.name === 'docs' ? 'docs' : JSON.stringify(view)} resetKey={JSON.stringify(view)}>
          {view.name === 'new' && <NewThreadView key={view.role ?? ''} initialRole={view.role} />}
          {view.name === 'threads' && <ThreadsView />}
          {view.name === 'done' && <ThreadsView done key="done" />}
          {view.name === 'inbox' && <InboxView itemId={view.itemId} />}
          {view.name === 'docs' && <DocsView docId={view.docId} />}
          {view.name === 'agents' && <AgentsView />}
          {view.name === 'team' && <TeamView />}
          {view.name === 'settings' && <SettingsView />}
          {view.name === 'thread' && <ThreadView key={view.threadId} threadId={view.threadId} sessionId={view.sessionId} />}
          {view.name === 'dm' && <DmView key={view.dmId} dmId={view.dmId} />}
          {view.name === 'message' && <NewMessageView />}
          </PaneErrorBoundary>
        </div>
      </div>
      </div>
    </div>
  );
}
