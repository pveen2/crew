import { useMemo, useState, type ReactNode } from 'react';
import { IconButton, InlineStack, Panel, PanelHeader, SegmentedControl, Tabs, Text } from '@crew/ui';
import { closePreview, selectPreview, setPreviewDevice, togglePreview, useApp, type PreviewDoc } from '../store';
import { Markdown, RoleFace, ago, useRoleLabel } from './common';

/** show_preview documents plus subagent results opened from a card, oldest first. */
/** A thread's documents. With `openOnly`, the tabs the owner closed are left out. */
export function usePreviewDocs(threadId: string, openOnly = false): PreviewDoc[] {
  const data = useApp((s) => s.details[threadId]);
  const extra = useApp((s) => s.extraPreviews[threadId]);
  const closed = useApp((s) => (openOnly ? s.closedPreviews[threadId] : undefined));
  return useMemo(() => {
    const fromEvents: PreviewDoc[] = (data?.events ?? []).flatMap((e) =>
      e.type === 'preview'
        ? [{ id: e.previewId, title: e.title, format: e.format, content: e.content, from: data?.sessions[e.sessionId]?.role ?? '', ts: e.ts }]
        : [],
    );
    return [...fromEvents, ...(extra ?? [])].filter((d) => !closed?.[d.id]).sort((a, b) => a.ts - b.ts);
  }, [data, extra, closed]);
}

/** "GM · Draft, not published · 46m ago" above a document. Shared by the preview and the Inbox. */
export function DocSourceBar({ doc, children }: { doc: PreviewDoc; children?: ReactNode }) {
  const fromLabel = useRoleLabel(doc.from ?? '');
  return (
    <InlineStack gap="250" paddingBlock="300" paddingInline="400" className="preview-bar">
      <InlineStack gap="150" grow className="preview-source">
        {doc.from ? <RoleFace role={doc.from} size="xs" /> : null}
        <Text as="span" variant="bodyLg" tone="secondary" truncate>
          {fromLabel ? `${fromLabel} · ` : ''}Draft, not published · {ago(doc.ts)}
        </Text>
      </InlineStack>
      {children}
    </InlineStack>
  );
}

/** Renders one document: Markdown, or HTML in a sandboxed frame. */
export function DocView({ doc, device = 'desktop' }: { doc: PreviewDoc; device?: 'desktop' | 'phone' }) {
  return (
    <div className={`doc-frame doc-frame--${device}`}>
      {doc.format === 'html' ? (
        <iframe title={doc.title} sandbox="" srcDoc={doc.content} />
      ) : (
        <div className="doc-scroll">
          <Markdown text={doc.content} className="md--doc" />
        </div>
      )}
    </div>
  );
}

export function PreviewPanel({ threadId, docs }: { threadId: string; docs: PreviewDoc[] }) {
  const selected = useApp((s) => s.preview[threadId]);
  const device = useApp((s) => s.previewDevice);
  const width = useApp((s) => s.previewWidth);
  const [copied, setCopied] = useState(false);
  const doc = docs.find((d) => d.id === selected) ?? docs.at(-1);

  return (
    <Panel as="aside" className="pane-preview" aria-label="Preview" style={width ? { flex: `0 1 ${width}px` } : undefined}>
      <PanelHeader>
        <Tabs
          label="Documents"
          value={doc?.id}
          onValueChange={(id) => selectPreview(threadId, id)}
          onClose={(id) => closePreview(threadId, id, docs.map((d) => d.id))}
          items={docs.map((d) => ({ value: d.id, label: d.title, title: d.title }))}
        />
        <span className="cr-spacer" />
        {doc ? (
          <IconButton
            icon={copied ? 'check' : 'copy'}
            label={copied ? 'Copied' : 'Copy document'}
            iconSize={14}
            onClick={() => {
              void navigator.clipboard.writeText(doc.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          />
        ) : null}
        <IconButton icon="close" label="Close preview" iconSize={14} onClick={() => togglePreview(false)} />
      </PanelHeader>
      {doc ? (
        <>
          <DocSourceBar doc={doc}>
            {/* Desktop/Phone only matters for layouts; a Markdown document just reads at full width. */}
            {doc.format === 'html' ? (
              <SegmentedControl
                label="Preview size"
                value={device}
                onValueChange={setPreviewDevice}
                items={[
                  { value: 'desktop', label: 'Desktop' },
                  { value: 'phone', label: 'Phone' },
                ]}
              />
            ) : null}
          </DocSourceBar>
          <DocView doc={doc} device={doc.format === 'html' ? device : 'desktop'} />
        </>
      ) : null}
    </Panel>
  );
}
