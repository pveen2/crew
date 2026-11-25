import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DocResponse, DocSummary } from '@crew/protocol';
import { BlockStack, Badge, Button, ChipSelect, Icon, IconButton, InlineStack, ListItem, Panel, PanelHeader, SegmentedControl, Spinner, Text, cx } from '@crew/ui';
import { ensureDoc, isNewDoc, isPhone, loadDoc, loadDocs, navigate, setDocArchived, setDocsFilter, setInboxListWidth, useApp, type DocsFilter, type PreviewDoc } from '../store';
import { PaneResizer } from './PaneResizer';
import { RoleFace, age, useNow, useRoleLabel } from './common';
import { ApproveButton, DocView } from './PreviewPanel';

/**
 * Docs: what agents put in front of the owner, one row per thread: an agent's new version of a doc
 * takes the place of the one before, and the older versions sit behind the version picker. Each
 * doc is a Draft until the owner approves it (approving archives the older drafts), and the
 * approved version is the one agents build on. To review holds drafts, as the Inbox holds what
 * waits on the owner; Archived holds what the owner is done with.
 */
export function DocsView({ docId }: { docId?: string }) {
  const docs = useApp((s) => s.docs);
  const filter = useApp((s) => s.docsFilter);
  const listWidth = useApp((s) => s.inboxListWidth);
  const now = useNow(30_000);

  const [loadError, setLoadError] = useState(false);
  const reload = useCallback(() => {
    setLoadError(false);
    loadDocs().catch(() => setLoadError(true));
  }, []);
  useEffect(reload, [reload]);
  // A link to a doc the list does not have (yet): fetch that one.
  const missing = Boolean(docs && docId && !docs[docId]);
  useEffect(() => {
    if (missing && docId) void ensureDoc(docId).catch(() => undefined);
  }, [missing, docId]);

  const all = useMemo(() => Object.values(docs ?? {}).sort((a, b) => b.shownAt - a.shownAt), [docs]);
  const selected = (docId && docs?.[docId]) || undefined;
  // The doc that is open keeps its row after it is archived (or approved, or restored), until another
  // doc or another tab is picked.
  const groups = useMemo(() => {
    const list = groupByThread(all.filter((d) => inFilter(d, filter)));
    if (selected && !list.some((g) => g[0]!.threadId === selected.threadId)) {
      const at = list.findIndex((g) => g[0]!.shownAt < selected.shownAt);
      list.splice(at < 0 ? list.length : at, 0, [selected]);
    }
    return list;
  }, [all, filter, selected]);
  const versionCounts = useMemo(() => {
    const n: Record<string, number> = {};
    for (const d of all) n[d.threadId] = (n[d.threadId] ?? 0) + 1;
    return n;
  }, [all]);

  useEffect(() => {
    if (!selected && groups[0] && !isPhone()) navigate({ name: 'docs', docId: groups[0][0]!.id });
  }, [selected, groups]);

  return (
    <>
      <Panel className={cx('pane-list', selected && 'phone-hide')} aria-label="Docs" style={listWidth ? { flex: `0 1 ${listWidth}px` } : undefined}>
        <PanelHeader>
          <Text as="h1" variant="headingSm" className="list-title">
            Docs
          </Text>
          <span className="cr-spacer" />
          <SegmentedControl
            label="Filter"
            value={filter}
            onValueChange={(f) => {
              if (f === filter) return;
              // A new tab starts from its own first doc, not the one open in the last tab.
              setDocsFilter(f);
              navigate({ name: 'docs' });
            }}
            items={[
              { value: 'review', label: 'To review' },
              { value: 'approved', label: 'Approved' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
        </PanelHeader>
        <div className="pane-scroll">
          <BlockStack gap="025" padding="200">
            {docs === null && loadError ? (
              <BlockStack gap="200" inlineAlign="start" className="list-empty">
                <Text tone="secondary">Couldn’t load Docs.</Text>
                <Button onClick={reload}>Retry</Button>
              </BlockStack>
            ) : docs === null ? (
              <div className="list-empty">
                <Spinner label="Loading docs" />
              </div>
            ) : groups.length === 0 ? (
              <Text tone="secondary" className="list-empty">
                {filter === 'archived'
                  ? 'Nothing archived. Archive a doc you are done with to clear it from the list.'
                  : filter === 'approved'
                    ? 'Nothing approved yet.'
                    : all.length
                      ? 'Nothing to review.'
                      : 'Docs agents show you appear here.'}
              </Text>
            ) : (
              groups.map((g) => (
                <DocRow
                  key={g[0]!.threadId}
                  group={g}
                  versions={versionCounts[g[0]!.threadId] ?? 1}
                  showStatus={filter === 'archived'}
                  open={selected?.threadId === g[0]!.threadId ? selected : undefined}
                  now={now}
                />
              ))
            )}
          </BlockStack>
        </div>
      </Panel>
      <PaneResizer target="before" label="Resize Docs list" min={260} minOther={420} onResize={setInboxListWidth} onReset={() => setInboxListWidth(null)} />
      <Panel as="main" className={cx('pane-main', !selected && 'phone-hide')}>
        {selected ? (
          <DocDetail key={selected.threadId} summary={selected} />
        ) : (
          <>
            <PanelHeader />
            <div className="pane-center">
              <BlockStack gap="200" inlineAlign="center">
                <Icon name="document" size={16} />
                <Text tone="secondary">No doc selected.</Text>
              </BlockStack>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}

function inFilter(d: DocSummary, filter: DocsFilter): boolean {
  if (filter === 'archived') return Boolean(d.archivedAt);
  if (d.archivedAt) return false;
  return filter === 'review' ? d.status === 'draft' : d.status === filter;
}

/** Docs (newest first) grouped by thread, newest group first; each group newest first. */
function groupByThread(docs: DocSummary[]): DocSummary[][] {
  const byThread = new Map<string, DocSummary[]>();
  for (const d of docs) {
    const g = byThread.get(d.threadId);
    if (g) g.push(d);
    else byThread.set(d.threadId, [d]);
  }
  return [...byThread.values()];
}

/** A thread's docs, newest first by when they were made: its versions. Showing one again does not make it newer. */
function useThreadDocs(threadId: string): DocSummary[] {
  const docs = useApp((s) => s.docs);
  return useMemo(
    () =>
      Object.values(docs ?? {})
        .filter((d) => d.threadId === threadId)
        .sort((a, b) => b.createdAt - a.createdAt || b.shownAt - a.shownAt),
    [docs, threadId],
  );
}

/**
 * One thread's docs. The row shows the version that is open (so it agrees with the header), else
 * the newest in view; clicking it opens the newest unread version (else the newest), so a new
 * version is one click away.
 */
function DocRow({ group, versions, showStatus, open, now }: { group: DocSummary[]; versions: number; showStatus: boolean; open?: DocSummary; now: number }) {
  const firstUnread = useApp((s) => group.find((d) => isNewDoc(d, s.docsSeen)));
  // Clicking opens the newest unread version, else the newest.
  const newest = firstUnread ?? group[0]!;
  const doc = open ?? group[0]!;
  const unread = Boolean(firstUnread);
  return (
    <ListItem
      title={doc.title}
      tooltip={doc.title}
      unread={unread}
      selected={Boolean(open)}
      onClick={() => navigate({ name: 'docs', docId: newest.id })}
      meta={age(doc.shownAt, now)}
      subtitle={
        <>
          {showStatus && doc.status === 'approved' ? (
            <>
              <Badge tone="success">Approved</Badge>
              {' · '}
            </>
          ) : null}
          {doc.threadTitle || 'Untitled thread'}
          {versions > 1 ? ` · ${versions} versions` : ''}
        </>
      }
      trailing={doc.agent ? <RoleFace role={doc.agent} size="sm" /> : undefined}
    />
  );
}

function DocDetail({ summary }: { summary: DocSummary }) {
  const [doc, setDoc] = useState<DocResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept across versions of one thread (so the version picker keeps focus); each version loads anew.
  useEffect(() => {
    let live = true;
    setDoc(null);
    setError(null);
    loadDoc(summary.id).then(
      (d) => live && setDoc(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [summary.id]);

  const preview: PreviewDoc | null = doc?.id === summary.id ? { id: doc.id, title: doc.title, format: doc.format, content: doc.content, artifactId: doc.id, from: doc.agent, ts: doc.shownAt } : null;
  const agentLabel = useRoleLabel(summary.agent);
  const openThread = () => {
    navigate({ name: 'thread', threadId: summary.threadId });
  };
  return (
    <>
      <PanelHeader className="inbox-detail-header">
        <IconButton icon="chevronLeft" label="Back to Docs" className="phone-only" onClick={() => navigate({ name: 'docs' })} />
        <InlineStack gap="200" paddingInline="150" className="detail-title">
          {summary.agent ? <RoleFace role={summary.agent} size="xs" /> : <Icon name="document" size={13} />}
          <Text as="h1" variant="headingSm" truncate title={[summary.title, summary.threadTitle, agentLabel].filter(Boolean).join(' · ')}>
            {summary.title}
          </Text>
          <VersionPicker summary={summary} />
        </InlineStack>
        <span className="cr-spacer" />
        <span className="inbox-detail-actions">
          <ArchiveButton key={summary.id} summary={summary} />
          <Button onClick={openThread}>Open thread</Button>
          {/* Only what the owner can see can be approved. */}
          {preview ? <ApproveButton id={summary.id} status={summary.status} size="medium" /> : null}
        </span>
      </PanelHeader>
      {preview ? (
        <DocView doc={preview} threadId={summary.threadId} />
      ) : (
        <div className="pane-center">{error ? <Text tone="critical">{error}</Text> : <Spinner label="Loading" />}</div>
      )}
    </>
  );
}

/** Which of the thread's versions is open, and when it came in. Older versions are one pick away. */
function VersionPicker({ summary }: { summary: DocSummary }) {
  const versions = useThreadDocs(summary.threadId);
  const now = useNow(30_000);
  const n = versions.length;
  if (n <= 1) {
    return (
      <Text as="span" tone="secondary" className="doc-age">
        {age(summary.shownAt, now)}
      </Text>
    );
  }
  const status = (d: DocSummary) => (d.status === 'approved' ? (d.archivedAt ? 'Approved, archived' : 'Approved') : d.archivedAt ? 'Archived' : 'Draft');
  const options = versions.map((d, i) => ({
    value: d.id,
    label: [`v${n - i}`, d.title, age(d.shownAt, now), status(d)].join(' · '),
  }));
  const at = versions.findIndex((d) => d.id === summary.id);
  return (
    <ChipSelect
      label="Version"
      value={summary.id}
      options={options}
      display={`v${n - at}/${n}`}
      onChange={(id) => navigate({ name: 'docs', docId: id })}
    />
  );
}

/** Archive clears the whole thread's docs from the list (every version); Restore brings back the one open. */
function ArchiveButton({ summary }: { summary: DocSummary }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const archived = Boolean(summary.archivedAt);
  const toggle = () => {
    setBusy(true);
    setFailed(false);
    void setDocArchived(summary.id, !archived, !archived)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <Button disabled={busy} onClick={toggle} title={archived ? 'Put it back in the Docs list' : 'Clear this doc and its versions from the list. They stay under Archived.'}>
      {failed ? 'Failed · Retry' : archived ? 'Restore' : 'Archive'}
    </Button>
  );
}
