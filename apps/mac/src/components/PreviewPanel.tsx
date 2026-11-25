import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DocStatus } from '@crew/protocol';
import { Button, IconButton, InlineStack, Panel, PanelHeader, SegmentedControl, Tabs, Text } from '@crew/ui';
import tokensCss from '@crew/ui/tokens.css?raw';
import documentCss from '@crew/ui/document.css?raw';
import { attachmentDataUrl, closePreview, ensureDoc, loadDocs, markDocSeen, setDocStatus, selectPreview, setPreviewDevice, togglePreview, updateWebPreview, useApp, type PreviewDoc } from '../store';
import { Markdown, RoleFace, ago, useRoleLabel } from './common';
import { ConceptBoard, conceptBoardText } from './ConceptBoard';

/** What every HTML document gets first: the Crew tokens and the document look. */
const DOCUMENT_CSS = `${tokensCss}\n${documentCss}`;

/** show_preview documents plus subagent results opened from a card, oldest first. */
/** A thread's documents. With `openOnly`, the tabs the owner closed are left out. */
export function usePreviewDocs(threadId: string, openOnly = false): PreviewDoc[] {
  const data = useApp((s) => s.details[threadId]);
  const extra = useApp((s) => s.extraPreviews[threadId]);
  const closed = useApp((s) => (openOnly ? s.closedPreviews[threadId] : undefined));
  return useMemo(() => {
    const fromEvents: PreviewDoc[] = (data?.events ?? []).flatMap((e) =>
      e.type === 'preview'
        ? [{ id: e.previewId, title: e.title, format: e.format, content: e.content, artifactId: e.artifactId, from: data?.sessions[e.sessionId]?.role ?? '', ts: e.ts }]
        : [],
    );
    return [...fromEvents, ...(extra ?? [])].filter((d) => !closed?.[d.id]).sort((a, b) => a.ts - b.ts);
  }, [data, extra, closed]);
}

/** "GM · Draft · 46m ago" above a document, with Approve. Shared by the preview, the Inbox and Docs. */
export function DocSourceBar({ doc, children }: { doc: PreviewDoc; children?: ReactNode }) {
  const fromLabel = useRoleLabel(doc.from ?? '');
  const status = useDocStatus(doc.artifactId);
  return (
    <InlineStack gap="250" paddingBlock="300" paddingInline="400" className="preview-bar">
      <InlineStack gap="150" grow className="preview-source">
        {doc.from ? <RoleFace role={doc.from} size="xs" /> : null}
        <Text as="span" variant="bodyLg" tone="secondary" truncate>
          {fromLabel ? `${fromLabel} · ` : ''}
          {status === 'approved' ? 'Approved' : 'Draft'} · {ago(doc.ts)}
        </Text>
      </InlineStack>
      {children}
      {doc.artifactId && status ? <ApproveButton id={doc.artifactId} status={status} /> : null}
    </InlineStack>
  );
}

/** A doc's status, loading the Docs list the first time it is needed. */
export function useDocStatus(artifactId: string | undefined): DocStatus | undefined {
  const loaded = useApp((s) => s.docs !== null);
  const status = useApp((s) => (artifactId ? s.docs?.[artifactId]?.status : undefined));
  useEffect(() => {
    if (artifactId && !loaded) void loadDocs();
  }, [artifactId, loaded]);
  // Not in the list (it changed since it loaded): fetch this one doc.
  useEffect(() => {
    if (artifactId && loaded && !status) void ensureDoc(artifactId).catch(() => undefined);
  }, [artifactId, loaded, status]);
  // Seeing a doc anywhere (thread preview, Docs) counts as opening it.
  useEffect(() => {
    if (artifactId) markDocSeen(artifactId);
  }, [artifactId]);
  return status;
}

export function ApproveButton({ id, status }: { id: string; status: DocStatus }) {
  const [busy, setBusy] = useState(false);
  const change = (next: DocStatus) => {
    setBusy(true);
    void setDocStatus(id, next).finally(() => setBusy(false));
  };
  return status === 'approved' ? (
    <Button size="slim" variant="tertiary" icon="check" disabled={busy} onClick={() => change('draft')} title="Approved. Click to move it back to draft.">
      Approved
    </Button>
  ) : (
    <Button size="slim" variant="primary" disabled={busy} onClick={() => change('approved')} title="Mark this as the version that counts">
      Approve
    </Button>
  );
}

/** The Electron <webview> methods the browser tab uses. */
interface WebviewElement extends HTMLWebViewElement {
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
}

/** "ads.meta.com", "https://…" or "glossier ads" → a URL to load. */
function toUrl(input: string): string {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[^\s]+\.[a-z]{2,}(\/|$)/i.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** A browser tab: back, forward, reload, the address and "open in browser", above the page. */
function WebDoc({ doc, threadId, hidden = false }: { doc: PreviewDoc; threadId: string; hidden?: boolean }) {
  const ref = useRef<WebviewElement>(null);
  // Load the first URL once; later navigation is the page's own, and `content` only remembers it.
  const [src] = useState(doc.content);
  const [address, setAddress] = useState(doc.content);
  const [nav, setNav] = useState({ back: false, forward: false, loading: true });

  useEffect(() => {
    const view = ref.current;
    if (!view) return;
    const sync = () => {
      const url = view.getURL();
      setAddress(url);
      setNav((n) => ({ ...n, back: view.canGoBack(), forward: view.canGoForward() }));
      if (/^https?:/.test(url)) updateWebPreview(threadId, doc.id, { content: url });
    };
    const title = (e: Event) => updateWebPreview(threadId, doc.id, { title: (e as Event & { title: string }).title });
    const start = () => setNav((n) => ({ ...n, loading: true }));
    const stop = () => setNav((n) => ({ ...n, loading: false }));
    view.addEventListener('did-navigate', sync);
    view.addEventListener('did-navigate-in-page', sync);
    view.addEventListener('page-title-updated', title);
    view.addEventListener('did-start-loading', start);
    view.addEventListener('did-stop-loading', stop);
    return () => {
      view.removeEventListener('did-navigate', sync);
      view.removeEventListener('did-navigate-in-page', sync);
      view.removeEventListener('page-title-updated', title);
      view.removeEventListener('did-start-loading', start);
      view.removeEventListener('did-stop-loading', stop);
    };
  }, [threadId, doc.id]);

  return (
    <div className="web-tab" hidden={hidden}>
      <InlineStack gap="100" paddingBlock="200" paddingInline="400" className="preview-bar">
        <IconButton icon="chevronLeft" label="Back" iconSize={14} disabled={!nav.back} onClick={() => ref.current?.goBack()} />
        <IconButton icon="chevronRight" label="Forward" iconSize={14} disabled={!nav.forward} onClick={() => ref.current?.goForward()} />
        <IconButton icon={nav.loading ? 'close' : 'reload'} label="Reload" iconSize={14} onClick={() => ref.current?.reload()} />
        <form
          className="web-address"
          onSubmit={(e) => {
            e.preventDefault();
            const url = toUrl(address);
            setAddress(url);
            void ref.current?.loadURL(url);
          }}
        >
          <input aria-label="Address" value={address} spellCheck={false} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => e.target.select()} />
        </form>
        <IconButton
          icon="arrowUpRight"
          label="Open in browser"
          iconSize={14}
          onClick={() => void window.crewHost?.openExternal?.(ref.current?.getURL() || doc.content)}
        />
      </InlineStack>
      <div className="doc-frame">
        {/* allowpopups as a string: React drops `true` on an attribute it does not know. Popups become new tabs (main.cjs). */}
        <webview ref={ref} src={src} partition="persist:crew-browser" {...({ allowpopups: 'true' } as object)} />
      </div>
    </div>
  );
}

/** `attachments/<file>` (or `./attachments/<file>`): a thread image an agent put in a document. */
const ATTACHMENT_SRC = /^(?:\.\/)?attachments\/([\w][\w.-]*)$/;

/**
 * Get an agent's HTML document ready for the sandboxed frame:
 * - Crew's tokens and document styles go first in <head>, so it looks like the app unless the
 *   agent styled it itself (the defaults have no specificity; see @crew/ui document.css).
 * - Thread images (`attachments/<file>`: the owner's uploads and screenshots agents kept) become
 *   data: URLs. The frame has no origin and cannot fetch from the conductor itself.
 * - Web links open as new tabs (the browser tab in the panel), never inside the frame: most sites
 *   refuse to be framed and the preview would go blank. Links within the report (#section) stay.
 */
async function prepareHtml(html: string, threadId: string | undefined): Promise<string> {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const a of parsed.querySelectorAll('a[href], area[href]')) {
    if (/^https?:\/\//i.test(a.getAttribute('href') ?? '')) a.setAttribute('target', '_blank');
  }
  const style = parsed.createElement('style');
  style.setAttribute('data-crew', '');
  style.textContent = DOCUMENT_CSS;
  parsed.head.prepend(style);

  const images = [...parsed.querySelectorAll('img[src], source[srcset], video[poster]')];
  await Promise.all(
    images.map(async (el) => {
      const attr = el.tagName === 'SOURCE' ? 'srcset' : el.tagName === 'VIDEO' ? 'poster' : 'src';
      const file = ATTACHMENT_SRC.exec((el.getAttribute(attr) ?? '').trim())?.[1];
      if (!file) return;
      if (!threadId) return el.setAttribute('alt', `${el.getAttribute('alt') ?? ''} (image not available here)`.trim());
      try {
        el.setAttribute(attr, await attachmentDataUrl(threadId, file));
      } catch {
        el.setAttribute('alt', `${el.getAttribute('alt') ?? ''} (image ${file} not found)`.trim());
      }
    }),
  );

  const dt = parsed.doctype;
  const doctype = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? `${dt.publicId ? '' : ' SYSTEM'} "${dt.systemId}"` : ''}>`
    : '<!DOCTYPE html>';
  return doctype + parsed.documentElement.outerHTML;
}

/** Renders one document: Markdown, HTML in a sandboxed frame, or a web page. */
export function DocView({ doc, device = 'desktop', threadId }: { doc: PreviewDoc; device?: 'desktop' | 'phone'; threadId?: string }) {
  const [html, setHtml] = useState<{ id: string; source: string; ready: string } | null>(null);
  useEffect(() => {
    if (doc.format !== 'html') return;
    let live = true;
    void prepareHtml(doc.content, threadId).then((ready) => live && setHtml({ id: doc.id, source: doc.content, ready }));
    return () => {
      live = false;
    };
  }, [doc.id, doc.format, doc.content, threadId]);

  if (doc.format === 'web' && threadId) return <WebDoc key={doc.id} doc={doc} threadId={threadId} />;
  return (
    <div className={`doc-frame doc-frame--${device}`}>
      {doc.format === 'html' ? (
        // Popups are allowed only so target="_blank" links reach the window-open handler, which opens them in the browser.
        // Rendered once its images are in, so the frame loads one time.
        html?.id === doc.id && html.source === doc.content ? <iframe title={doc.title} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={html.ready} /> : null
      ) : doc.format === 'concepts' ? (
        <div className="doc-scroll">
          <ConceptBoard content={doc.content} docId={doc.id} threadId={threadId} />
        </div>
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
            label={copied ? 'Copied' : doc.format === 'web' ? 'Copy link' : 'Copy document'}
            iconSize={14}
            onClick={() => {
              void navigator.clipboard.writeText(doc.format === 'concepts' ? conceptBoardText(doc.content) : doc.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          />
        ) : null}
        <IconButton icon="close" label="Close preview" iconSize={14} onClick={() => togglePreview(false)} />
      </PanelHeader>
      {/* Every browser tab stays mounted, hidden when another tab is selected, so its page and history survive. */}
      {docs
        .filter((d) => d.format === 'web')
        .map((d) => (
          <WebDoc key={d.id} doc={d} threadId={threadId} hidden={d.id !== doc?.id} />
        ))}
      {doc && doc.format !== 'web' ? (
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
          <DocView doc={doc} device={doc.format === 'html' ? device : 'desktop'} threadId={threadId} />
        </>
      ) : null}
    </Panel>
  );
}
