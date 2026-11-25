import { useEffect, useMemo, useState } from 'react';
import type { InboxItem } from '@crew/protocol';
import { BlockStack, Button, Card, Disclosure, Icon, InlineStack, Panel, PanelHeader, Text, cx, type IconName } from '@crew/ui';
import { ensureThreads, inScope, markRead, mergePullRequest, navigate, openExternal, resolveInbox, resumeThread, useApp } from '../store';
import { Markdown, PersonFace, RoleFace, ScopeToggle, age, useNow, usePersonName, useRoleLabel } from './common';
import { ApprovalActions } from './ApprovalCard';
import { QuestionAnswer } from './QuestionAnswer';

/**
 * The Inbox: only what an agent is waiting on (a question, an approval, a run that stopped),
 * and pull requests a Developer opened, which wait for the owner to review and merge.
 * Every item is a card with its action on it, and it leaves the Inbox once handled. Drafts are
 * not here: they live in Docs.
 */
const KIND: Record<InboxItem['kind'], { label: string; icon: IconName; order: number }> = {
  needs_you: { label: 'Question', icon: 'question', order: 0 },
  approval: { label: 'Approval', icon: 'question', order: 0 },
  interrupted: { label: 'Interrupted', icon: 'alert', order: 1 },
  error: { label: 'Failed', icon: 'alert', order: 2 },
  pull_request: { label: 'Pull request', icon: 'checkCircle', order: 1 },
  // From builds before Docs; cleared on the conductor's next start.
  draft: { label: 'Draft', icon: 'document', order: 3 },
};

export function InboxView({ itemId }: { itemId?: string }) {
  const inbox = useApp((s) => s.inbox);
  const threads = useApp((s) => s.threads);
  const me = useApp((s) => s.me);
  const scope = useApp((s) => s.scope);
  const now = useNow(30_000);
  const all = Object.keys(inbox).length;
  const items = useMemo(
    () =>
      Object.values(inbox)
        // Mine: items from my threads. One whose thread is not loaded (a closed one) shows.
        .filter((i) => !threads[i.threadId] || inScope(threads[i.threadId], { me, scope }))
        .sort((a, b) => (KIND[a.kind]?.order ?? 9) - (KIND[b.kind]?.order ?? 9) || b.createdAt - a.createdAt),
    [inbox, threads, me, scope],
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
        <Text as="span" tone="secondary" className="phone-hide">
          {items.length ? `${items.length} waiting${scope === 'all' && me ? '' : ' on you'}` : ''}
        </Text>
        <ScopeToggle />
      </PanelHeader>
      <div className="pane-scroll">
        {items.length === 0 ? (
          <div className="pane-center inbox-empty">
            <BlockStack gap="200" inlineAlign="center">
              <Icon name="checkCircle" size={16} />
              <Text tone="secondary">Nothing is waiting on you.</Text>
              {all > 0 && (
                <Text variant="bodySm" tone="tertiary">
                  {all} waiting in the team’s threads, under All.
                </Text>
              )}
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
  const me = useApp((s) => s.me);
  const owner = me && thread?.createdBy && thread.createdBy !== me ? thread.createdBy : null;
  const ownerName = usePersonName(owner);
  const role = useItemRole(item);
  const roleLabel = useRoleLabel(role);
  // A newer conductor may send kinds this build does not know yet.
  const kind = KIND[item.kind] ?? { label: 'Update', icon: 'alert' as IconName, order: 9 };
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
            {[roleLabel, thread?.title, ownerName && `${ownerName}’s thread`].filter(Boolean).join(' · ')}
          </Text>
          {owner ? <PersonFace email={owner} size={16} /> : null}
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
          <InlineStack gap="200" wrap className="inbox-card-actions">
            <Button variant="tertiary" onClick={openThread}>
              Open thread
            </Button>
            <span className="cr-spacer" />
            {item.kind === 'approval' ? (
              <ApprovalActions item={item} />
            ) : item.kind === 'pull_request' ? (
              <PullRequestActions item={item} />
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

/** Done, Review on GitHub, and Merge: a second click confirms, since a merge lands on the base branch. */
function PullRequestActions({ item }: { item: InboxItem }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 5000);
    return () => window.clearTimeout(t);
  }, [confirming]);
  const merge = async () => {
    if (!confirming) return setConfirming(true);
    setBusy(true);
    setError('');
    try {
      await mergePullRequest(item.id);
    } catch (err) {
      setError((err as Error).message || 'Could not merge.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button onClick={() => void resolveInbox(item.id)}>Done</Button>
      {item.url ? (
        <>
          <Button icon="arrowUpRight" onClick={() => openExternal(item.url!)}>
            Review on GitHub
          </Button>
          <Button variant="primary" icon="check" disabled={busy} onClick={() => void merge()}>
            {busy ? 'Merging…' : confirming ? 'Confirm merge' : 'Merge'}
          </Button>
        </>
      ) : null}
      {error ? (
        <Text variant="bodySm" tone="critical" role="alert" className="inbox-card-error">
          {error}
        </Text>
      ) : null}
    </>
  );
}
