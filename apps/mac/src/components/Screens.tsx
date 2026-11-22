// New thread and Threads: no v5 design, composed from the system in the same style.

import { useMemo, useRef, useState } from 'react';
import {
  BlockStack,
  Card,
  CardRowButton,
  ChipSelect,
  Composer,
  Icon,
  IconButton,
  ListItem,
  Panel,
  PanelHeader,
  Text,
} from '@crew/ui';
import { createThread, navigate, useApp } from '../store';
import { AttachmentTray, useAttachments } from './attachments';
import { RoleFace, RoleFaces, age, useNow } from './common';

const SUGGESTIONS = [
  'Welke producten verkochten de afgelopen 30 dagen het best, en wat valt op?',
  'Bedenk drie campagnerichtingen voor de donkere wintermaanden.',
  'Check onze productpagina’s op ontbrekende afbeeldingen, SEO-teksten en voorraadproblemen.',
  'Schrijf een conceptmail voor klanten die al 60 dagen niet hebben besteld.',
];

export function NewThreadView({ initialRole }: { initialRole?: string }) {
  const roles = useApp((s) => s.roles);
  const online = useApp((s) => s.connection === 'online');
  const [text, setText] = useState('');
  const images = useAttachments();
  const [role, setRole] = useState(initialRole ?? 'gm');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    if ((!text.trim() && !images.files.length) || busy) return;
    setBusy(true);
    setError('');
    try {
      await createThread(text.trim(), role, images.files);
      setText('');
      images.clear();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const options = roles.length ? roles.map((r) => ({ value: r.name, label: r.label })) : [{ value: 'gm', label: 'GM' }];

  return (
    <Panel as="main" className="pane-main pane-page">
      <div className="page-drag cr-drag" />
      <div className="pane-scroll">
        <BlockStack gap="600" className="new-thread">
          <BlockStack gap="100">
            <Text variant="headingLg">What do you need?</Text>
            <Text tone="secondary">Every question becomes its own thread. The GM picks it up and pulls in the right specialists.</Text>
          </BlockStack>
          <BlockStack gap="200" {...images.dropProps}>
            <AttachmentTray files={images.files} onRemove={images.remove} />
            <Composer
              ref={ref}
              size="tall"
              label="New thread"
              autoFocus
              value={text}
              onChange={setText}
              onSubmit={() => void submit()}
              onPaste={images.onPaste}
              disabled={!online}
              placeholder="Ask the team anything…"
              leading={
                <>
                  <Text as="span" variant="bodySm" tone="secondary" className="to-label">
                    To
                  </Text>
                  <ChipSelect label="Send to" value={role} onChange={setRole} options={options} prefix={<RoleFace role={role} size="xs" decorative />} />
                  {images.button}
                </>
              }
              trailing={
                <IconButton tone="primary" icon="arrowUp" label="Start thread" disabled={(!text.trim() && !images.files.length) || busy || !online} onClick={() => void submit()} />
              }
            />
            {error || images.error ? (
              <Text variant="bodySm" tone="critical">
                {error || images.error}
              </Text>
            ) : (
              <Text variant="caption" tone="tertiary">
                Enter sends, Shift+Enter adds a line. Paste or drop images to attach them. Read and draft only: nothing is published.
              </Text>
            )}
          </BlockStack>
          <BlockStack gap="200">
            <Text variant="headingMd">Try</Text>
            <Card>
              {SUGGESTIONS.map((s) => (
                <CardRowButton
                  key={s}
                  onClick={() => {
                    setText(s);
                    ref.current?.focus();
                  }}
                >
                  <Text as="span" variant="bodyLg" className="grow" truncate>
                    {s}
                  </Text>
                  <Icon name="arrowUpRight" size={12} />
                </CardRowButton>
              ))}
            </Card>
          </BlockStack>
        </BlockStack>
      </div>
    </Panel>
  );
}

/** Open threads, or with `done` the closed ones. */
export function ThreadsView({ done = false }: { done?: boolean }) {
  const threads = useApp((s) => (done ? s.done : s.threads));
  const now = useNow(30_000);
  const list = useMemo(() => Object.values(threads).sort((a, b) => b.updatedAt - a.updatedAt), [threads]);
  return (
    <Panel as="main" className="pane-main">
      <PanelHeader>
        <Text as="h1" variant="headingSm" className="list-title">
          {done ? 'Done' : 'Threads'}
        </Text>
      </PanelHeader>
      <div className="pane-scroll">
        <BlockStack gap="025" className="threads-list">
          {list.length === 0 && (
            <Text tone="secondary" className="list-empty">
              {done ? 'No closed threads yet.' : 'No threads yet. Start one with New thread.'}
            </Text>
          )}
          {list.map((t) => (
            <ListItem
              key={t.id}
              title={t.title}
              tooltip={t.title}
              unread={!done && (t.status === 'needs_you' || t.status === 'interrupted' || t.status === 'error')}
              onClick={() => navigate({ name: 'thread', threadId: t.id })}
              meta={age(t.updatedAt, now)}
              subtitle={t.statusText}
              trailing={<RoleFaces roles={t.roles} size="sm" />}
            />
          ))}
        </BlockStack>
      </div>
    </Panel>
  );
}
