import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DocResponse, DocSummary } from '@crew/protocol';
import { BlockStack, Badge, Button, Icon, IconButton, InlineStack, ListItem, Panel, PanelHeader, SegmentedControl, Spinner, Text, cx } from '@crew/ui';
import { ensureDoc, isNewDoc, isPhone, loadDoc, loadDocs, navigate, setDocArchived, setDocsFilter, setInboxListWidth, useApp, type DocsFilter, type PreviewDoc } from '../store';
import { PaneResizer } from './PaneResizer';
import { RoleFace, age, useNow } from './common';
import { DocSourceBar, DocView } from './PreviewPanel';

const FORMAT: Record<DocSummary['format'], string> = {
  markdown: 'Document',
  html: 'Layout',
  concepts: 'Concept board',
};

/**
 * Docs: everything agents put in front of the owner, across threads, newest first. Each doc is a
 * Draft until the owner approves it; the approved version is the one agents build on. Docs the
 * owner is done with go to the archive: out of the list, still there under Archived.
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
  // The doc that is open stays in the list after it is archived (or restored), until another is picked.
  const items = all.filter((d) => d.id === docId || inFilter(d, filter));
  const selected = (docId && docs?.[docId]) || undefined;

  useEffect(() => {
    if (!selected && items[0] && !isPhone()) navigate({ name: 'docs', docId: items[0].id });
  }, [selected, items]);

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
            onValueChange={setDocsFilter}
            items={[
              { value: 'all', label: 'All' },
              { value: 'draft', label: 'Draft' },
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
            ) : items.length === 0 ? (
              <Text tone="secondary" className="list-empty">
                {filter === 'archived'
                  ? 'Nothing archived. Archive a doc you are done with to clear it from the list.'
                  : all.length
                    ? filter === 'approved'
                      ? 'Nothing approved yet.'
                      : filter === 'draft'
                        ? 'No drafts waiting.'
                        : 'Everything is archived.'
                    : 'Docs agents show you appear here.'}
              </Text>
            ) : (
              items.map((d) => <DocRow key={d.id} doc={d} selected={d.id === selected?.id} now={now} />)
            )}
          </BlockStack>
        </div>
      </Panel>
      <PaneResizer target="before" label="Resize Docs list" min={260} minOther={420} onResize={setInboxListWidth} onReset={() => setInboxListWidth(null)} />
      <Panel as="main" className={cx('pane-main', !selected && 'phone-hide')}>
        {selected ? (
          <DocDetail key={selected.id} summary={selected} />
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
  return filter === 'all' || d.status === filter;
}

function DocRow({ doc, selected, now }: { doc: DocSummary; selected: boolean; now: number }) {
  const unread = useApp((s) => isNewDoc(doc, s.docsSeen));
  return (
    <ListItem
      title={doc.title}
      tooltip={doc.title}
      unread={unread}
      selected={selected}
      onClick={() => navigate({ name: 'docs', docId: doc.id })}
      meta={age(doc.shownAt, now)}
      subtitle={
        <>
          {doc.archivedAt ? <span>Archived · </span> : null}
          {doc.status === 'approved' ? <Badge tone="success">Approved</Badge> : <span>Draft</span>}
          {` · ${FORMAT[doc.format]}`}
          {doc.threadTitle ? ` · ${doc.threadTitle}` : ''}
        </>
      }
      trailing={doc.agent ? <RoleFace role={doc.agent} size="sm" /> : undefined}
    />
  );
}

function DocDetail({ summary }: { summary: DocSummary }) {
  const [doc, setDoc] = useState<DocResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadDoc(summary.id).then(
      (d) => live && setDoc(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [summary.id]);

  const preview: PreviewDoc | null = doc && { id: doc.id, title: doc.title, format: doc.format, content: doc.content, artifactId: doc.id, from: doc.agent, ts: doc.shownAt };
  const openThread = () => {
    navigate({ name: 'thread', threadId: summary.threadId });
  };
  return (
    <>
      <PanelHeader className="inbox-detail-header">
        <IconButton icon="chevronLeft" label="Back to Docs" className="phone-only" onClick={() => navigate({ name: 'docs' })} />
        <InlineStack gap="200" paddingInline="150" className="detail-title">
          <Icon name="document" size={13} />
          <Text as="h1" variant="headingSm" truncate title={summary.title}>
            {summary.title}
          </Text>
          {summary.threadTitle ? (
            <Text as="span" variant="bodyLg" tone="secondary" truncate>
              {summary.threadTitle}
            </Text>
          ) : null}
        </InlineStack>
        <span className="cr-spacer" />
        <span className="inbox-detail-actions">
          <ArchiveButton summary={summary} />
          <Button onClick={openThread}>Open thread</Button>
        </span>
      </PanelHeader>
      {preview ? (
        <>
          <DocSourceBar doc={preview} />
          <DocView doc={preview} threadId={summary.threadId} />
        </>
      ) : (
        <div className="pane-center">{error ? <Text tone="critical">{error}</Text> : <Spinner label="Loading" />}</div>
      )}
    </>
  );
}

function ArchiveButton({ summary }: { summary: DocSummary }) {
  const [busy, setBusy] = useState(false);
  const archived = Boolean(summary.archivedAt);
  const toggle = () => {
    setBusy(true);
    void setDocArchived(summary.id, !archived).finally(() => setBusy(false));
  };
  return (
    <Button disabled={busy} onClick={toggle} title={archived ? 'Put it back in the Docs list' : 'Clear it from the Docs list. It stays under Archived.'}>
      {archived ? 'Restore' : 'Archive'}
    </Button>
  );
}
