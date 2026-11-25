import { useEffect, useMemo } from 'react';
import type { InboxItem } from '@crew/protocol';
import { BlockStack, Button, Card, Disclosure, Icon, InlineStack, Panel, PanelHeader, Text, cx, type IconName } from '@crew/ui';
import { decideApproval, ensureThreads, markRead, navigate, resolveInbox, resumeThread, useApp } from '../store';
import { Markdown, RoleFace, age, useNow, useRoleLabel } from './common';
import { QuestionAnswer } from './QuestionAnswer';

/**
 * The Inbox: only what an agent is waiting on (a question, an approval, a run that stopped).
 * Every item is a card with its action on it, and it leaves the Inbox once handled. Drafts are
 * not here: they live in Docs.
 */
const KIND: Record<InboxItem['kind'], { label: string; icon: IconName; order: number }> = {
  needs_you: { label: 'Question', icon: 'question', order: 0 },
  approval: { label: 'Approval', icon: 'question', order: 0 },
  interrupted: { label: 'Interrupted', icon: 'alert', order: 1 },
  error: { label: 'Failed', icon: 'alert', order: 2 },
  // From builds before Docs; cleared on the conductor's next start.
  draft: { label: 'Draft', icon: 'document', order: 3 },
};

export function InboxView({ itemId }: { itemId?: string }) {
  const inbox = useApp((s) => s.inbox);
  const now = useNow(30_000);
  const items = useMemo(
    () => Object.values(inbox).sort((a, b) => KIND[a.kind].order - KIND[b.kind].order || b.createdAt - a.createdAt),
    [inbox],
  );

  // Know which agent raised each item.
  useEffect(() => ensureThreads(items.map((i) => i.threadId)), [items]);
  // Everything is on screen at once: looking at the Inbox reads it.
  useEffect(() => markRead(items.map((i) => i.id)), [items]);
  // A link to one item (#inbox/<id>) scrolls to it, once its card is there.
  const targetShown = Boolean(itemId && inbox[itemId]);
  useEffect(() => {
    if (itemId && targetShown) document.getElementById(`inbox-${itemId}`)?.scrollIntoView({ block: 'center' });
  }, [itemId, targetShown]);

  return (
    <Panel as="main" className="pane-main" aria-label="Inbox">
      <PanelHeader>
        <Text as="h1" variant="headingSm" className="list-title">
          Inbox
        </Text>
        <span className="cr-spacer" />
        <Text as="span" tone="secondary">
          {items.length ? `${items.length} waiting on you` : ''}
        </Text>
      </PanelHeader>
      <div className="pane-scroll">
        {items.length === 0 ? (
          <div className="pane-center inbox-empty">
            <BlockStack gap="200" inlineAlign="center">
              <Icon name="checkCircle" size={16} />
              <Text tone="secondary">Nothing is waiting on you.</Text>
              <Text variant="bodySm" tone="tertiary">
                Drafts to review are in Docs.
              </Text>
            </BlockStack>
          </div>
        ) : (
          <BlockStack gap="300" className="inbox-cards">
            {items.map((item, i) => (
              <InboxCard key={item.id} item={item} now={now} focused={item.id === itemId} autoFocus={i === 0 && !itemId} />
            ))}
          </BlockStack>
        )}
      </div>
    </Panel>
  );
}

/** The agent behind an item: from the thread's sessions once loaded, else the thread owner. */
function useItemRole(item: InboxItem): string {
  return useApp((s) => item.role || s.details[item.threadId]?.sessions[item.sessionId]?.role || s.threads[item.threadId]?.roles[0] || '');
}

function InboxCard({ item, now, focused, autoFocus }: { item: InboxItem; now: number; focused: boolean; autoFocus: boolean }) {
  const thread = useApp((s) => s.threads[item.threadId]);
  const role = useItemRole(item);
  const roleLabel = useRoleLabel(role);
  const kind = KIND[item.kind];
  const openThread = () =>
    navigate({ name: 'thread', threadId: item.threadId, sessionId: item.sessionId === thread?.rootSessionId ? undefined : item.sessionId });

  // A question's title is its first line, cut at 140 characters: drop that line from the body
  // only when the title shows all of it.
  const [firstLine, ...rest] = item.body.split('\n');
  const body = item.kind === 'needs_you' && firstLine?.trim() === item.title.trim() ? rest.join('\n').trim() : item.body;

  return (
    <Card id={`inbox-${item.id}`} padded className={cx('inbox-card', `inbox-card--${item.kind}`, focused && 'inbox-card--focused')}>
      <BlockStack gap="300">
        <InlineStack gap="200" className="inbox-card-meta">
          <Icon name={kind.icon} size={13} />
          <Text as="span" variant="bodySm" weight="medium">
            {kind.label}
          </Text>
          <Text as="span" variant="bodySm" tone="secondary" truncate className="grow">
            {[roleLabel, thread?.title].filter(Boolean).join(' · ')}
          </Text>
          <Text as="span" variant="bodySm" tone="tertiary">
            {age(item.createdAt, now)}
          </Text>
          {role ? <RoleFace role={role} size="xs" /> : null}
        </InlineStack>

        <Text as="h2" variant="headingSm">
          {item.title}
        </Text>

        {item.kind === 'approval' ? (
          <Disclosure summary="What it wants to run">
            <Markdown text={body} />
          </Disclosure>
        ) : body ? (
          <Markdown text={body} />
        ) : null}

        {item.kind === 'needs_you' ? (
          <QuestionAnswer
            threadId={item.threadId}
            sessionId={item.sessionId}
            inboxId={item.id}
            options={item.options}
            recommended={item.recommended}
            multiSelect={item.multiSelect}
            autoFocus={autoFocus || focused}
            actions={
              <Button variant="tertiary" onClick={openThread}>
                Open thread
              </Button>
            }
          />
        ) : (
          <InlineStack gap="200" className="inbox-card-actions">
            <Button variant="tertiary" onClick={openThread}>
              Open thread
            </Button>
            <span className="cr-spacer" />
            {item.kind === 'approval' ? (
              <>
                <Button onClick={() => void decideApproval(item.id, false)}>Deny</Button>
                <Button variant="primary" onClick={() => void decideApproval(item.id, true)}>
                  Approve
                </Button>
              </>
            ) : item.kind === 'interrupted' ? (
              <>
                <Button onClick={() => void resolveInbox(item.id)}>Dismiss</Button>
                <Button variant="primary" icon="play" onClick={() => void resumeThread(item.threadId)}>
                  Resume
                </Button>
              </>
            ) : (
              <Button onClick={() => void resolveInbox(item.id)}>Dismiss</Button>
            )}
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}
