import { useEffect, useMemo, useState } from 'react';
import type { ConnectionStatus, Thread } from '@crew/protocol';
import { IconButton, Icon, ListItem, NavItem, Spinner, Text, cx } from '@crew/ui';
import { navigate, signInConnection, useApp } from '../store';
import { RoleFaces, age, useNow } from './common';

export function Sidebar() {
  const view = useApp((s) => s.view);
  const teamName = useApp((s) => s.teamName) || 'Crew';
  const threads = useApp((s) => s.threads);
  const doneCount = useApp((s) => Object.keys(s.done).length);
  const inbox = useApp((s) => s.inbox);
  const inboxRead = useApp((s) => s.inboxRead);
  const activity = useApp((s) => s.activity);
  const connection = useApp((s) => s.connection);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const now = useNow(1000);

  const sorted = useMemo(() => Object.values(threads).sort((a, b) => b.updatedAt - a.updatedAt), [threads]);
  const inboxItems = Object.values(inbox);
  const unreadInbox = inboxItems.filter((i) => !inboxRead[i.id]);
  const unreadThreads = new Set(unreadInbox.map((i) => i.threadId));
  const workingCount = activity.filter((a) => a.status === 'running').length;

  /** Earliest start of running work per thread, for the "↻ 40s" meta. */
  const runningSince = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of activity) if (a.status === 'running') m.set(a.threadId, Math.min(m.get(a.threadId) ?? Infinity, a.since));
    return m;
  }, [activity]);

  const attention = (t: Thread) => t.status === 'needs_you' || t.status === 'interrupted' || t.status === 'error' || unreadThreads.has(t.id);

  return (
    <nav className={cx('sidebar', collapsed && 'sidebar--collapsed')} aria-label="Main">
      {/* Folded: an icon rail with the same destinations. */}
      <div className="sidebar-rail" inert={!collapsed}>
        <IconButton tone="dark" size="md" icon="plus" label="New thread" title="New thread  ⌘N" pressed={view.name === 'new'} onClick={() => navigate({ name: 'new' })} />
        <IconButton tone="dark" size="md" icon="threads" label="Threads" pressed={view.name === 'threads'} onClick={() => navigate({ name: 'threads' })} />
        <span className="sidebar-rail-item">
          <IconButton tone="dark" size="md" icon="inbox" label="Inbox" pressed={view.name === 'inbox'} onClick={() => navigate({ name: 'inbox' })} />
          {inboxItems.length > 0 && <span className="cr-dot cr-dot--notification" aria-hidden />}
        </span>
        <IconButton tone="dark" size="md" icon="agents" label="Agents" pressed={view.name === 'agents'} onClick={() => navigate({ name: 'agents' })} />
        <span className="cr-spacer" />
        <IconButton tone="dark" size="md" icon="checkCircle" label="Done" pressed={view.name === 'done'} onClick={() => navigate({ name: 'done' })} />
        <span className={`sidebar-conn--${connection} sidebar-rail-conn`} role="status" title={connection === 'online' ? 'Conductor connected' : connection === 'connecting' ? 'Connecting…' : 'Conductor offline'}>
          <Icon name={connection === 'online' ? 'checkCircle' : connection === 'offline' ? 'wifiOff' : 'clock'} size={14} />
        </span>
      </div>

      <div className="sidebar-full" inert={collapsed}>
      <div className="sidebar-top">
        <span className="sidebar-brand">
          <span className="brand-tile" aria-hidden>
            {teamName.slice(0, 1).toUpperCase()}
          </span>
          <Text as="span" variant="bodyLg" weight="semibold" tone="sidebar">
            {teamName}
          </Text>
        </span>
        <span className="cr-spacer" />
      </div>

      <NavItem variant="raised" icon="plus" label="New thread" shortcut="⌘N" selected={view.name === 'new'} onClick={() => navigate({ name: 'new' })} className="sidebar-new" />
      <NavItem icon="threads" label="Threads" selected={view.name === 'threads'} onClick={() => navigate({ name: 'threads' })} />
      <NavItem
        icon="inbox"
        label="Inbox"
        count={inboxItems.length}
        // Red dot while anything in the Inbox waits for the owner, as in the design.
        dot={inboxItems.length > 0}
        selected={view.name === 'inbox'}
        onClick={() => navigate({ name: 'inbox' })}
      />
      <NavItem
        icon="agents"
        label="Agents"
        selected={view.name === 'agents'}
        onClick={() => navigate({ name: 'agents' })}
        count={workingCount || undefined}
      />

      <div className="sidebar-section">
        <span>Active threads</span>
        <span className="numeric">{sorted.length || ''}</span>
      </div>

      <div className="sidebar-threads">
        {sorted.length === 0 && (
          <Text variant="caption" tone="sidebarSecondary" className="sidebar-empty">
            No threads yet. Start one with New thread.
          </Text>
        )}
        {sorted.map((t) => {
          const since = runningSince.get(t.id);
          const strong = attention(t);
          return (
            <ListItem
              key={t.id}
              surface="dark"
              title={t.title}
              tooltip={t.title}
              unread={strong}
              selected={view.name === 'thread' && view.threadId === t.id}
              onClick={() => navigate({ name: 'thread', threadId: t.id })}
              meta={
                since !== undefined ? (
                  <>
                    <Spinner size={11} label="Working" />
                    <span>{age(since, now)}</span>
                  </>
                ) : (
                  age(t.updatedAt, now)
                )
              }
              subtitle={<span className={strong ? 'sidebar-status-strong' : undefined}>{t.statusText}</span>}
              trailing={<RoleFaces roles={t.roles} size="xs" />}
            />
          );
        })}
      </div>

      <NavItem icon="checkCircle" label="Done" count={doneCount || undefined} selected={view.name === 'done'} onClick={() => navigate({ name: 'done' })} />

      <div className="sidebar-footer">
        <UpdateButton working={workingCount} />
        <Connections />
        <div className={`sidebar-conn sidebar-conn--${connection}`} role="status">
          <Icon name={connection === 'online' ? 'checkCircle' : connection === 'offline' ? 'wifiOff' : 'clock'} size={14} />
          <span>{connection === 'online' ? 'Conductor connected' : connection === 'connecting' ? 'Connecting…' : 'Conductor offline'}</span>
        </div>
      </div>
      </div>
    </nav>
  );
}

/** Shows when main on GitHub has new commits; pulls and restarts Crew. */
function UpdateButton({ working }: { working: number }) {
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const host = window.crewHost;
    if (!host?.updateCheck) return;
    const check = () => void host.updateCheck().then(setCount, () => {});
    check();
    const timer = setInterval(check, 10 * 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!count) return null;

  const update = async () => {
    if (working && !window.confirm(`${working} agent${working === 1 ? ' is' : 's are'} working. Updating restarts Crew and stops them. Update now?`)) return;
    setBusy(true);
    const error = await window.crewHost!.updateApply();
    if (error) {
      setBusy(false);
      window.alert(`Could not update:\n${error}`);
    }
  };

  return (
    <NavItem
      icon="arrowUp"
      label="Update Crew"
      className="sidebar-update"
      title={`${count} new change${count === 1 ? '' : 's'} on main. Click to update and restart.`}
      disabled={busy}
      onClick={() => void update()}
      suffix={<span className="sidebar-tool-action">{busy ? <Spinner size={11} label="Updating" /> : count}</span>}
    />
  );
}

const STATUS_TEXT: Record<ConnectionStatus['status'], string> = {
  connected: 'Connected',
  signed_out: 'Not signed in',
  missing: 'Not installed',
  unknown: 'Could not check',
};

function connectionTitle(c: ConnectionStatus, waiting: boolean): string {
  const lines = [`${c.label}: ${STATUS_TEXT[c.status]}${c.detail ? ` (${c.detail})` : ''}`];
  lines.push(c.usedBy.length ? `Used by ${c.usedBy.join(', ')}` : 'Not used by the team right now');
  if (waiting) lines.push('Finish in Terminal. This updates when it is done.');
  else if (c.canSignIn) lines.push(c.status === 'missing' ? 'Click to install and sign in, in Terminal' : 'Click to sign in, in Terminal');
  return lines.join('\n');
}

/** The engine CLIs and services the team uses. Click one that is not connected to sign in. */
function Connections() {
  const connections = useApp((s) => s.connections);
  const signingIn = useApp((s) => s.signingIn);
  // Connected tools drop out of the list; with everything connected there is no section.
  const shown = connections.filter((c) => c.status !== 'connected');
  if (!shown.length) return null;

  return (
    <div className="sidebar-tools" role="group" aria-label="Connected tools">
      <span className="cr-visually-hidden" role="status" aria-live="polite">
        {shown.filter((c) => signingIn[c.id]).map((c) => `${c.label}: finish signing in in Terminal.`).join(' ')}
      </span>
      {shown.map((c) => {
        const waiting = Boolean(signingIn[c.id]);
        const ok = c.status === 'connected';
        return (
          <NavItem
            key={c.id}
            icon={ok ? 'checkCircle' : waiting ? 'clock' : c.status === 'unknown' ? 'question' : 'alert'}
            label={c.label}
            className={cx('sidebar-tool', `sidebar-tool--${c.status}`, !c.usedBy.length && 'sidebar-tool--unused')}
            title={connectionTitle(c, waiting)}
            disabled={ok || waiting || !c.canSignIn}
            onClick={() => void signInConnection(c.id)}
            suffix={
              <span className="sidebar-tool-action">
                {waiting ? <Spinner size={11} label="Waiting for sign-in" /> : ok ? null : c.canSignIn ? (c.status === 'missing' ? 'Install' : 'Sign in') : STATUS_TEXT[c.status]}
              </span>
            }
          />
        );
      })}
    </div>
  );
}
