import { useEffect, useMemo, useState } from 'react';
import type { DocResponse, DocSummary } from '@crew/protocol';
import { BlockStack, Badge, Button, Icon, IconButton, InlineStack, ListItem, Panel, PanelHeader, SegmentedControl, Spinner, Text, cx } from '@crew/ui';
import { isNewDoc, isPhone, loadDoc, loadDocs, navigate, setDocsFilter, setInboxListWidth, useApp, type PreviewDoc } from '../store';
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
 * Draft until the owner approves it; the approved version is the one agents build on.
 */
export function DocsView({ docId }: { docId?: string }) {
  const docs = useApp((s) => s.docs);
  const filter = useApp((s) => s.docsFilter);
  const listWidth = useApp((s) => s.inboxListWidth);
  const now = useNow(30_000);

  useEffect(() => void loadDocs(), []);

  const all = useMemo(() => Object.values(docs ?? {}).sort((a, b) => b.shownAt - a.shownAt), [docs]);
  const items = filter === 'all' ? all : all.filter((d) => d.status === filter || d.id === docId);
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
            ]}
          />
        </PanelHeader>
        <div className="pane-scroll">
          <BlockStack gap="025" padding="200">
            {docs === null ? (
              <div className="list-empty">
                <Spinner label="Loading docs" />
              </div>
            ) : items.length === 0 ? (
              <Text tone="secondary" className="list-empty">
                {all.length ? (filter === 'approved' ? 'Nothing approved yet.' : 'No drafts waiting.') : 'Docs agents show you appear here.'}
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
