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
  InlineStack,
  ListItem,
  Panel,
  PanelHeader,
  Text,
  type MentionOption,
} from '@crew/ui';
import { createThread, dmTitle, inScope, navigate, takeNewDraft, useApp } from '../store';
import { AttachmentTray, useAttachments } from './attachments';
import { isPhoneTouch } from '../swipe';
import { PersonFace, RoleFace, RoleFaces, ScopeToggle, age, useNow, usePersonName } from './common';

export function NewThreadView({ initialRole }: { initialRole?: string }) {
  const roles = useApp((s) => s.roles);
  // Example questions come from the team (suggestions in crew.config.ts).
  const suggestions = useApp((s) => s.suggestions);
  const online = useApp((s) => s.connection === 'online');
  // "Run again" from a thread opens this screen with its question and team.
  const [draft] = useState(takeNewDraft);
  const [text, setText] = useState(draft?.text ?? '');
  const images = useAttachments();
  const lead = roles.find((r) => r.isLead)?.name ?? 'gm';
  const [role, setRole] = useState(draft?.role ?? initialRole ?? lead);
  const [benched, setBenched] = useState<string[]>(draft?.benched ?? []);
  // Only the lead calls specialists, so the team row is for threads it owns.
  const specialists = role === lead ? roles.filter((r) => !r.isLead) : [];
  const toggle = (name: string) => setBenched((b) => (b.includes(name) ? b.filter((n) => n !== name) : [...b, name]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    if ((!text.trim() && !images.files.length) || busy) return;
    setBusy(true);
    setError('');
    try {
      await createThread(text.trim(), role, images.files, role === lead ? benched.filter((n) => specialists.some((s) => s.name === n)) : []);
      setText('');
      images.clear();
      setBenched([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // "@developer …" to the lead: the lead starts that specialist in the new thread.
  const mentions = useMemo<MentionOption[]>(
    () =>
      specialists
        .filter((r) => !benched.includes(r.name))
        .map((r) => ({ value: r.name, label: r.label, description: r.description, prefix: <RoleFace role={r.name} size="sm" decorative /> })),
    [specialists, benched],
  );

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
              enterSends={!isPhoneTouch()}
              size="tall"
              label="New thread"
              autoFocus
              value={text}
              onChange={setText}
              onSubmit={() => void submit()}
              onPaste={images.onPaste}
              mentions={mentions}
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
            {specialists.length > 0 && (
              <InlineStack gap="100" wrap className="team-toggles" role="group" aria-label="Specialists in this thread">
                <Text as="span" variant="bodySm" tone="secondary" className="to-label">
                  Team
                </Text>
                {specialists.map((r) => {
                  const off = benched.includes(r.name);
                  return (
                    <button
                      key={r.name}
                      type="button"
                      className={`team-toggle${off ? ' team-toggle--off' : ''}`}
                      aria-pressed={!off}
                      title={off ? `${r.label} is off for this thread. Click to switch on.` : `Switch ${r.label} off for this thread`}
                      onClick={() => toggle(r.name)}
                    >
                      <RoleFace role={r.name} size="xs" decorative />
                      {r.label}
                    </button>
                  );
                })}
              </InlineStack>
            )}
            {error || images.error ? (
              <Text variant="bodySm" tone="critical">
                {error || images.error}
              </Text>
            ) : (
              <Text variant="caption" tone="tertiary">
                {/* A phone: Return adds a line and the button sends, so no keyboard hints. */}
                {isPhoneTouch() ? null : 'Enter sends, Shift+Enter adds a line. Paste or drop images to attach them. '}
                Read and draft only: nothing is published.
              </Text>
            )}
          </BlockStack>
          {suggestions.length > 0 && (
            <BlockStack gap="200">
              <Text variant="headingMd">Try</Text>
              <Card>
                {suggestions.map((s) => (
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
          )}
        </BlockStack>
      </div>
    </Panel>
  );
}

/** Open threads, or with `done` the closed ones. */
export function ThreadsView({ done = false }: { done?: boolean }) {
  const threads = useApp((s) => (done ? s.done : s.threads));
  const me = useApp((s) => s.me);
  const scope = useApp((s) => s.scope);
  const people = useApp((s) => s.people);
  const now = useNow(30_000);
  const list = useMemo(
    // Open DMs are under Messages; closed ones are here in Done, so they stay findable.
    () => Object.values(threads).filter((t) => (done || !t.dm) && inScope(t, { me, scope })).sort((a, b) => b.updatedAt - a.updatedAt),
    [threads, me, scope],
  );
  const hidden = Object.values(threads).filter((t) => done || !t.dm).length - list.length;
  return (
    <Panel as="main" className="pane-main">
      <PanelHeader>
        <Text as="h1" variant="headingSm" className="list-title">
          {done ? 'Done' : 'Threads'}
        </Text>
        <span className="cr-spacer" />
        <ScopeToggle />
      </PanelHeader>
      <div className="pane-scroll">
        <BlockStack gap="025" className="threads-list">
          {list.length === 0 && (
            <Text tone="secondary" className="list-empty">
              {hidden > 0
                ? `None of yours. ${hidden} from the team under All.`
                : done
                  ? 'No closed threads yet.'
                  : 'No threads yet. Start one with New thread.'}
            </Text>
          )}
          {list.map((t) => (
            <ListItem
              key={t.id}
              title={t.dm ? `Message · ${dmTitle(t, me, people)}` : t.title}
              tooltip={t.title}
              unread={!done && (t.status === 'needs_you' || t.status === 'interrupted' || t.status === 'error')}
              onClick={() => navigate({ name: 'thread', threadId: t.id })}
              meta={age(t.updatedAt, now)}
              subtitle={<ThreadSubtitle text={t.statusText} createdBy={me && t.createdBy !== me ? t.createdBy : null} />}
              trailing={
                me && t.createdBy && t.createdBy !== me ? (
                  <span className="list-trailing">
                    <PersonFace email={t.createdBy} size={18} />
                    <RoleFaces roles={t.roles} size="sm" />
                  </span>
                ) : (
                  <RoleFaces roles={t.roles} size="sm" />
                )
              }
            />
          ))}
        </BlockStack>
      </div>
    </Panel>
  );
}

/** A thread's status, and whose thread it is when it is someone else's. */
function ThreadSubtitle({ text, createdBy }: { text: string; createdBy?: string | null }) {
  const name = usePersonName(createdBy);
  return <>{name ? `${name} · ${text}` : text}</>;
}
