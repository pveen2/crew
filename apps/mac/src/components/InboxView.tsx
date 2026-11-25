import { useEffect, useMemo } from 'react';
import type { InboxItem } from '@crew/protocol';
import { BlockStack, Button, Icon, IconButton, InlineStack, ListItem, Panel, PanelHeader, SegmentedControl, Text, cx, type IconName } from '@crew/ui';
import { isPhone, setInboxListWidth } from '../store';
import { PaneResizer } from './PaneResizer';
import { decideApproval, ensureThreads, navigate, resolveInbox, resumeThread, selectPreview, setInboxFilter, useApp } from '../store';
import { Markdown, RoleFace, age, ago, useNow, useRoleLabel } from './common';
import { DocSourceBar, DocView, usePreviewDocs } from './PreviewPanel';
import { QuestionAnswer } from './QuestionAnswer';
import type { PreviewDoc } from '../store';

const KIND: Record<InboxItem['kind'], { label: string; icon: IconName; order: number }> = {
  needs_you: { label: 'Answer a question', icon: 'question', order: 0 },
  approval: { label: 'Approve a tool call', icon: 'question', order: 0 },
  interrupted: { label: 'Interrupted', icon: 'alert', order: 1 },
  error: { label: 'Failed', icon: 'alert', order: 2 },
  draft: { label: 'Draft to review', icon: 'document', order: 3 },
};

function itemTitle(item: InboxItem): string {
  return item.title.replace(/^Draft ready:\s*/, '');
}

/** The agent behind an item: from the thread's sessions once loaded, else the thread owner. */
function useItemRole(item: InboxItem | undefined): string {
  return useApp((s) => {
    if (!item) return '';
    return item.role || s.details[item.threadId]?.sessions[item.sessionId]?.role || s.threads[item.threadId]?.roles[0] || '';
  });
}

function InboxRow({ item, selected, unread, now }: { item: InboxItem; selected: boolean; unread: boolean; now: number }) {
  const thread = useApp((s) => s.threads[item.threadId]);
  const role = useItemRole(item);
  return (
    <ListItem
      title={itemTitle(item)}
      tooltip={itemTitle(item)}
      unread={unread}
      selected={selected}
      onClick={() => navigate({ name: 'inbox', itemId: item.id })}
      meta={age(item.createdAt, now)}
      subtitle={
        <>
          <span className={unread ? 'inbox-kind-strong' : undefined}>{KIND[item.kind].label}</span>
          {thread ? ` · ${thread.title}` : ''}
        </>
      }
      trailing={role ? <RoleFace role={role} size="sm" /> : undefined}
    />
  );
}

/** The preview document a draft item points at: by previewId, or by title for items from older builds. */
function useDraftDoc(item: InboxItem): PreviewDoc | undefined {
  const docs = usePreviewDocs(item.threadId);
  if (item.kind !== 'draft') return undefined;
  if (item.previewId) return docs.find((d) => d.id === item.previewId);
  const title = itemTitle(item);
  const matches = docs.filter((d) => d.title === title);
  return [...matches].sort((a, b) => Math.abs(a.ts - item.createdAt) - Math.abs(b.ts - item.createdAt))[0];
}


function InboxDetail({ item }: { item: InboxItem }) {
  const thread = useApp((s) => s.threads[item.threadId]);
  const role = useItemRole(item);
  const roleLabel = useRoleLabel(role);
  const kind = KIND[item.kind];
  const doc = useDraftDoc(item);
  const openThread = () => {
    if (doc) {
      // Drafts open in the thread owner's view, with the draft in the preview pane.
      selectPreview(item.threadId, doc.id);
      navigate({ name: 'thread', threadId: item.threadId });
      return;
    }
    navigate({ name: 'thread', threadId: item.threadId, sessionId: item.sessionId === thread?.rootSessionId ? undefined : item.sessionId });
  };
  return (
    <>
      <PanelHeader className="inbox-detail-header">
        <IconButton icon="chevronLeft" label="Back to the Inbox" className="phone-only" onClick={() => navigate({ name: 'inbox' })} />
        <InlineStack gap="200" paddingInline="150" className="detail-title">
          <Icon name={kind.icon} size={13} />
          <Text as="h1" variant="headingSm" truncate title={itemTitle(item)}>
            {itemTitle(item)}
          </Text>
          <Text as="span" variant="bodyLg" tone="secondary" truncate>
            {[roleLabel, ago(item.createdAt)].filter(Boolean).join(' · ')}
          </Text>
        </InlineStack>
        <span className="cr-spacer" />
        <span className="inbox-detail-actions">
        <Button onClick={openThread}>Open thread</Button>
        <span className="header-gap" />
        {item.kind === 'approval' ? (
          <>
            <Button variant="tertiary" onClick={() => void decideApproval(item.id, false)}>
              Deny
            </Button>
            <Button variant="primary" onClick={() => void decideApproval(item.id, true)}>
              Approve
            </Button>
          </>
        ) : item.kind === 'interrupted' ? (
          <>
            <Button variant="tertiary" onClick={() => void resolveInbox(item.id)}>
              Dismiss
            </Button>
            <Button variant="primary" icon="play" onClick={() => void resumeThread(item.threadId)}>
              Resume
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => void resolveInbox(item.id)}>
            Done
          </Button>
        )}
        </span>
      </PanelHeader>
      {doc ? (
        // A draft looks exactly like it does in the thread's preview pane.
        <>
          <DocSourceBar doc={doc} />
          <DocView doc={doc} threadId={item.threadId} />
        </>
      ) : (
      <div className="pane-scroll">
        <BlockStack gap="400" className="reading">
          {thread ? (
            <Text variant="caption" tone="secondary">
              {kind.label} · {thread.title}
            </Text>
          ) : null}
          <Markdown text={item.body} />
          {item.kind === 'needs_you' ? (
            <QuestionAnswer threadId={item.threadId} sessionId={item.sessionId} inboxId={item.id} options={item.options} recommended={item.recommended} multiSelect={item.multiSelect} autoFocus />
          ) : null}
          {item.kind === 'interrupted' || item.kind === 'error' ? (
            <Text variant="bodySm" tone="secondary">
              {item.kind === 'interrupted'
                ? 'The conductor stopped while this was running. Resume picks up the agent’s own session where it left off.'
                : 'Open the thread to see what went wrong, or retry from there.'}
            </Text>
          ) : null}
        </BlockStack>
      </div>
      )}
    </>
  );
}

export function InboxView({ itemId }: { itemId?: string }) {
  const inbox = useApp((s) => s.inbox);
  const read = useApp((s) => s.inboxRead);
  const filter = useApp((s) => s.inboxFilter);
  const now = useNow(30_000);

  const all = useMemo(
    () => Object.values(inbox).sort((a, b) => KIND[a.kind].order - KIND[b.kind].order || b.createdAt - a.createdAt),
    [inbox],
  );
  const items = filter === 'unread' ? all.filter((i) => !read[i.id] || i.id === itemId) : all;
  const selected = (itemId && inbox[itemId]) || undefined;

  // Know which agent raised each item.
  useEffect(() => ensureThreads(all.map((i) => i.threadId)), [all]);
  // Keep a selection: the first item when none (or a resolved one) is selected.
  const listWidth = useApp((s) => s.inboxListWidth);
  // On a phone the list is its own screen: nothing is picked for you.
  useEffect(() => {
    if (!selected && items[0] && !isPhone()) navigate({ name: 'inbox', itemId: items[0].id });
  }, [selected, items]);

  return (
    <>
      <Panel className={cx('pane-list', selected && 'phone-hide')} aria-label="Inbox" style={listWidth ? { flex: `0 1 ${listWidth}px` } : undefined}>
        <PanelHeader>
          <Text as="h1" variant="headingSm" className="list-title">
            Inbox
          </Text>
          <span className="cr-spacer" />
          <SegmentedControl
            label="Filter"
            value={filter}
            onValueChange={setInboxFilter}
            items={[
              { value: 'all', label: 'All' },
              { value: 'unread', label: 'Unread' },
            ]}
          />
        </PanelHeader>
        <div className="pane-scroll">
          <BlockStack gap="025" padding="200">
            {items.length === 0 ? (
              <Text tone="secondary" className="list-empty">
                {all.length ? 'No unread items.' : 'Nothing needs you right now.'}
              </Text>
            ) : (
              items.map((i) => <InboxRow key={i.id} item={i} selected={i.id === selected?.id} unread={!read[i.id]} now={now} />)
            )}
          </BlockStack>
        </div>
      </Panel>
      <PaneResizer target="before" label="Resize Inbox list" min={260} minOther={420} onResize={setInboxListWidth} onReset={() => setInboxListWidth(null)} />
      <Panel as="main" className={cx('pane-main', !selected && 'phone-hide')}>
        {selected ? (
          <InboxDetail key={selected.id} item={selected} />
        ) : (
          <>
            <PanelHeader />
            <div className="pane-center">
              <BlockStack gap="200" inlineAlign="center">
                <Icon name="checkCircle" size={16} />
                <Text tone="secondary">Nothing needs you right now.</Text>
              </BlockStack>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}

