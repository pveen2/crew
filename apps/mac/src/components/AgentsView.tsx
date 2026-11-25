import { useMemo } from 'react';
import type { AgentActivity, RoleSummary } from '@crew/protocol';
import { BlockStack, Button, Card, CardRowButton, InlineStack, Panel, Spinner, Text } from '@crew/ui';
import { navigate, useApp } from '../store';
import { RoleFace, duration, engineName, useNow, useRoleLabels } from './common';

function WorkingRow({ a, now }: { a: AgentActivity; now: number }) {
  const labels = useRoleLabels();
  return (
    <CardRowButton spacious onClick={() => navigate({ name: 'thread', threadId: a.threadId, sessionId: a.sessionId })}>
      <RoleFace role={a.role} size="xl" decorative />
      <BlockStack className="grow">
        <Text as="span" variant="bodyLg" leading="snug" truncate>
          <strong className="author">{labels[a.role] ?? a.role}</strong>
          <Text as="span" variant="bodyLg" tone="secondary">
            {' '}
            · {a.threadTitle}
          </Text>
        </Text>
        <Text as="span" variant="caption" tone="secondary" leading="snug" truncate>
          {a.status === 'queued' ? 'Queued' : a.doing || 'Working'}
        </Text>
      </BlockStack>
      <Spinner size={14} tone="info" />
      <Text as="span" variant="caption" tone="secondary" numeric className="working-time">
        {duration(now - a.since)}
      </Text>
    </CardRowButton>
  );
}

function RoleCard({ role, activity }: { role: RoleSummary; activity: AgentActivity[] }) {
  const working = activity.find((a) => a.status === 'running') ?? activity.find((a) => a.status === 'queued');
  const attention = activity.find((a) => a.status === 'interrupted' || a.status === 'error');
  const state = working
    ? { label: working.status === 'queued' ? 'Queued' : 'Working', tone: 'info' as const }
    : attention
      ? { label: attention.status === 'error' ? 'Failed' : 'Interrupted', tone: 'caution' as const }
      : { label: 'Idle', tone: 'secondary' as const };
  const target = working ?? attention;
  return (
    <Card>
      <CardRowButton
        spacious
        className="role-card"
        title={role.description}
        onClick={() =>
          target ? navigate({ name: 'thread', threadId: target.threadId, sessionId: target.sessionId }) : navigate({ name: 'new', role: role.name })
        }
      >
        <RoleFace role={role.name} size="2xl" decorative />
        <BlockStack className="grow">
          <Text as="span" variant="bodyLg" weight="semibold" leading="snug" truncate>
            {role.label}
          </Text>
          <Text as="span" variant="caption" tone="secondary" leading="snug" truncate>
            {role.description}
          </Text>
          <Text as="span" variant="micro" tone="tertiary" leading="snug" truncate>
            {engineName(role.engine)} · {role.model} · {role.permissions === 'draft' ? 'drafts' : role.permissions === 'code' ? 'code, pull requests' : 'read only'}
          </Text>
        </BlockStack>
        <Text as="span" variant="caption" tone={state.tone} className="no-shrink">
          {state.label}
        </Text>
      </CardRowButton>
    </Card>
  );
}

export function AgentsView() {
  const roles = useApp((s) => s.roles);
  const activity = useApp((s) => s.activity);
  const now = useNow(1000);
  const working = useMemo(
    () => activity.filter((a) => a.status === 'running' || a.status === 'queued').sort((a, b) => a.since - b.since),
    [activity],
  );
  const byRole = useMemo(() => {
    const m = new Map<string, AgentActivity[]>();
    for (const a of activity) m.set(a.role, [...(m.get(a.role) ?? []), a]);
    return m;
  }, [activity]);
  const workingRoles = new Set(working.map((a) => a.role)).size;

  return (
    <Panel as="main" className="pane-main pane-page">
      <div className="page-drag cr-drag" />
      <div className="pane-scroll">
        <BlockStack gap="700" className="page">
          <InlineStack gap="300" wrap>
            <BlockStack className="grow">
              <Text variant="headingLg">Agents</Text>
              <Text variant="bodyMd" tone="secondary">
                {roles.length} {roles.length === 1 ? 'agent' : 'agents'} · {workingRoles} working now
              </Text>
            </BlockStack>
            <Button variant="primary" size="large" onClick={() => navigate({ name: 'new' })}>
              New thread
            </Button>
          </InlineStack>

          <BlockStack as="section" gap="200" aria-label="Working now">
            <Text variant="headingMd">Working now</Text>
            <Card>
              {working.length ? (
                working.map((a) => <WorkingRow key={a.sessionId} a={a} now={now} />)
              ) : (
                <Text tone="secondary" className="card-empty">
                  Nobody is working right now.
                </Text>
              )}
            </Card>
          </BlockStack>

          <BlockStack as="section" gap="200" aria-label="Everyone">
            <Text variant="headingMd">Everyone</Text>
            <div className="role-grid">
              {roles.map((r) => (
                <RoleCard key={r.name} role={r} activity={byRole.get(r.name) ?? []} />
              ))}
            </div>
          </BlockStack>
        </BlockStack>
      </div>
    </Panel>
  );
}
