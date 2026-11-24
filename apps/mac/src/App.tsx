import { useEffect } from 'react';
import { Banner, IconButton } from '@crew/ui';
import { navigate, toggleSidebar, useApp } from './store';
import { Sidebar } from './components/Sidebar';
import { ThreadView } from './components/ThreadView';
import { InboxView } from './components/InboxView';
import { AgentsView } from './components/AgentsView';
import { TeamView } from './components/TeamView';
import { NewThreadView, ThreadsView } from './components/Screens';

export function App() {
  const view = useApp((s) => s.view);
  const connection = useApp((s) => s.connection);
  const startError = useApp((s) => s.conductorStartError);
  const collapsed = useApp((s) => s.sidebarCollapsed);

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
    <div className={`app cr-root ${window.crewHost ? 'in-electron' : 'in-browser'}`}>
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
          onClick={() => toggleSidebar()}
        />
      </header>
      <div className="app-body">
      <Sidebar />
      <div className="workspace">
        {connection === 'offline' && (
          <Banner tone="caution" icon="wifiOff">
            {startError ?? (window.crewHost?.startConductor
              ? 'Can’t reach the conductor. You can start it from the sidebar.'
              : 'Can’t reach the conductor. Crew will reconnect when it’s available.')}
          </Banner>
        )}
        <div className="panes">
          {view.name === 'new' && <NewThreadView key={view.role ?? ''} initialRole={view.role} />}
          {view.name === 'threads' && <ThreadsView />}
          {view.name === 'done' && <ThreadsView done key="done" />}
          {view.name === 'inbox' && <InboxView itemId={view.itemId} />}
          {view.name === 'agents' && <AgentsView />}
          {view.name === 'team' && <TeamView />}
          {view.name === 'thread' && <ThreadView key={view.threadId} threadId={view.threadId} sessionId={view.sessionId} />}
        </div>
      </div>
      </div>
    </div>
  );
}
