import { useEffect, useMemo, useState } from 'react';
import type { ConnectionStatus, Thread } from '@crew/protocol';
import { Button, IconButton, Icon, ListItem, NavItem, Spinner, Text, cx } from '@crew/ui';
import { forMe, inScope, isNewDoc, navigate, startConductor, signInConnection, useApp, type UpdateInfo } from '../store';
import { offerMacApp } from '../macApp';
import { PersonFace, RoleFaces, ScopeToggle, age, usageLabel, usageTitle, useNow } from './common';

export function Sidebar() {
  const view = useApp((s) => s.view);
  const showSpend = useApp((s) => s.showSpend);
  const teamName = useApp((s) => s.teamName) || 'Crew';
  const threads = useApp((s) => s.threads);
  const me = useApp((s) => s.me);
  const scope = useApp((s) => s.scope);
  const doneCount = useApp((s) => Object.keys(s.done).length);
  const inbox = useApp((s) => s.inbox);
  const inboxRead = useApp((s) => s.inboxRead);
  // Docs lists one row per thread, so count threads with a new draft.
  const newDocs = useApp((s) => (s.docs ? new Set(Object.values(s.docs).filter((d) => isNewDoc(d, s.docsSeen)).map((d) => d.threadId)).size : 0));
  const activity = useApp((s) => s.activity);
  const connection = useApp((s) => s.connection);
  const starting = useApp((s) => s.conductorStarting);
  const canStart = connection === 'offline' && Boolean(window.crewHost?.startConductor);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const now = useNow(1000);

  const sorted = useMemo(
    () => Object.values(threads).filter((t) => inScope(t, { me, scope })).sort((a, b) => b.updatedAt - a.updatedAt),
    [threads, me, scope],
  );
  // The Inbox count follows Mine / All too. An item whose thread is not loaded counts.
  const inboxItems = Object.values(inbox).filter((i) => forMe(i, me) && (!threads[i.threadId] || inScope(threads[i.threadId], { me, scope })));
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
        <IconButton tone="dark" size="md" icon="document" label="Docs" pressed={view.name === 'docs'} onClick={() => navigate({ name: 'docs' })} />
        <IconButton tone="dark" size="md" icon="agents" label="Agents" pressed={view.name === 'agents'} onClick={() => navigate({ name: 'agents' })} />
        <span className="cr-spacer" />
        <IconButton tone="dark" size="md" icon="checkCircle" label="Done" pressed={view.name === 'done'} onClick={() => navigate({ name: 'done' })} />
        <IconButton tone="dark" size="md" icon="settings" label="Settings" pressed={view.name === 'settings'} onClick={() => navigate({ name: 'settings' })} />
        {canStart ? (
          <IconButton tone="dark" size="md" icon={starting ? 'clock' : 'play'} label={starting ? 'Starting conductor…' : 'Start conductor'} disabled={starting} onClick={() => void startConductor()} />
        ) : connection !== 'online' && (
          // Only shown when something is off; being connected is the normal state.
          <span className={`sidebar-conn--${connection} sidebar-rail-conn`} role="status" title={connection === 'connecting' ? 'Connecting…' : 'Conductor offline'}>
            <Icon name={connection === 'offline' ? 'wifiOff' : 'clock'} size={14} />
          </span>
        )}
      </div>

      <div className="sidebar-full" inert={collapsed}>
      <div className="sidebar-top">
        <button type="button" className="sidebar-brand" title="Team: where the agents come from" onClick={() => navigate({ name: 'team' })}>
          <span className="brand-tile" aria-hidden>
            {teamName.slice(0, 1).toUpperCase()}
          </span>
          <Text as="span" variant="bodyLg" weight="semibold" tone="sidebar">
            {teamName}
          </Text>
        </button>
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
      <NavItem icon="document" label="Docs" count={newDocs || undefined} selected={view.name === 'docs'} onClick={() => navigate({ name: 'docs' })} />
      <NavItem
        icon="agents"
        label="Agents"
        selected={view.name === 'agents'}
        onClick={() => navigate({ name: 'agents' })}
        count={workingCount || undefined}
      />

      <div className="sidebar-section">
        <span>{me ? 'Threads' : 'Active threads'}</span>
        {me ? <ScopeToggle tone="dark" /> : <span className="numeric">{sorted.length || ''}</span>}
      </div>

      <div className="sidebar-threads">
        {sorted.length === 0 && (
          <Text variant="caption" tone="sidebarSecondary" className="sidebar-empty">
            {me && scope === 'mine' && Object.keys(threads).length
              ? 'None of yours. All shows the whole team’s.'
              : 'No threads yet. Start one with New thread.'}
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
              subtitle={
                <>
                  <span className={strong ? 'sidebar-status-strong' : undefined}>{t.statusText}</span>
                  {showSpend && usageLabel(t.usage) ? (
                    <span className="sidebar-cost numeric" title={usageTitle(t.usage)}>
                      {' · '}
                      {usageLabel(t.usage)}
                    </span>
                  ) : null}
                </>
              }
              trailing={
                // Under All, someone else's thread shows who started it.
                me && t.createdBy && t.createdBy !== me ? (
                  <span className="list-trailing">
                    <PersonFace email={t.createdBy} size={14} />
                    <RoleFaces roles={t.roles} size="xs" />
                  </span>
                ) : (
                  <RoleFaces roles={t.roles} size="xs" />
                )
              }
            />
          );
        })}
      </div>

      <NavItem icon="checkCircle" label="Done" count={doneCount || undefined} selected={view.name === 'done'} onClick={() => navigate({ name: 'done' })} />

      <div className="sidebar-footer">
        <NavItem icon="settings" label="Settings" selected={view.name === 'settings'} onClick={() => navigate({ name: 'settings' })} />
        {offerMacApp && <NavItem icon="download" label="Get the Mac app" onClick={() => navigate({ name: 'settings' })} />}
        <UpdateButton working={workingCount} label="Update team" check={window.crewHost?.teamCheck} apply={window.crewHost?.teamApply} />
        <UpdateButton working={workingCount} label="Update Crew" check={window.crewHost?.updateCheck} apply={window.crewHost?.updateApply} />
        <Connections />
        {/* Only shown when something is off; being connected is the normal state. */}
        {connection !== 'online' && (
          <div className={`sidebar-conn sidebar-conn--${connection}`}>
            <Icon name={connection === 'offline' ? 'wifiOff' : 'clock'} size={14} />
            <span role="status">{connection === 'connecting' ? 'Connecting…' : 'Conductor offline'}</span>
            {canStart && <Button size="slim" icon="play" disabled={starting} aria-label="Start conductor" onClick={() => void startConductor()}>{starting ? 'Starting…' : 'Start'}</Button>}
          </div>
        )}
      </div>
      </div>
    </nav>
  );
}

/**
 * Shows when an update is waiting. "Update Crew": new commits on main, or a new
 * release of the installed app. "Update team": new commits for a team from GitHub.
 */
function UpdateButton({
  working,
  label,
  check,
  apply,
}: {
  working: number;
  label: string;
  check?: () => Promise<UpdateInfo | null>;
  apply?: () => Promise<string | null>;
}) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!check) return;
    const run = () => void check().then(setInfo, () => {});
    run();
    const timer = setInterval(run, 10 * 60_000);
    return () => clearInterval(timer);
  }, [check]);
  if (!info) return null;

  const update = async () => {
    if (info.stopsAgents && working && !window.confirm(`${working} agent${working === 1 ? ' is' : 's are'} working. Updating restarts the conductor and stops them. Update now?`)) return;
    setBusy(true);
    const error = await apply!();
    // A git update of Crew quits the app. Otherwise the app stays: a team update
    // restarts only the conductor, a release opens its download page.
    setBusy(false);
    if (error) window.alert(`Could not update:\n${error}`);
    else setInfo(null);
  };

  return (
    <NavItem
      icon="arrowUp"
      label={label}
      className="sidebar-update"
      title={info.title}
      disabled={busy}
      onClick={() => void update()}
      suffix={<span className="sidebar-tool-action">{busy ? <Spinner size={11} label="Updating" /> : info.badge}</span>}
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
  const lines = [`${c.label}: ${STATUS_TEXT[c.status]}${c.onServer ? ' on the server' : ''}${c.detail ? ` (${c.detail})` : ''}`];
  lines.push(c.usedBy.length ? `Used by ${c.usedBy.join(', ')}` : 'Not used by the team right now');
  if (waiting) lines.push('Finish in Terminal. This updates when it is done.');
  else if (c.onServer) lines.push('The server admin signs it in, once, for the whole team.');
  else if (c.canSignIn) lines.push(c.status === 'missing' ? 'Click to install and sign in, in Terminal' : 'Click to sign in, in Terminal');
  return lines.join('\n');
}

/** The engine CLIs and services the team uses. Click one that is not connected to sign in. */
function Connections() {
  const connections = useApp((s) => s.connections);
  const signingIn = useApp((s) => s.signingIn);
  // Connected tools drop out of the list; with everything connected there is no section.
  // On a server only what the team uses: nobody can act on the rest from here.
  const shown = connections.filter(
    (c) => c.status !== 'connected' && (c.id !== 'shopify' || c.usedBy.length > 0) && (!c.onServer || c.usedBy.length > 0),
  );
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
