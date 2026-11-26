// Direct messages (team server): plain chats between people, like Slack. No agent
// is in them. New message picks who it goes to (To:), then you write.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DmMessage, Person } from '@crew/protocol';
import { BlockStack, Button, Composer, IconButton, InlineStack, Panel, PanelHeader, Shimmer, Text, cx } from '@crew/ui';
import { dmName, dmWith, isPhone, loadDm, loadOlderDm, markDmSeen, setPreviewDm, navigate, personName, sendDm, sendDmTo, sendTyping, useApp } from '../store';
import { isPhoneTouch } from '../swipe';
import { AttachmentTray, MessageImages, useAttachments } from './attachments';
import { Markdown, OnlineFace, PersonFace, clock } from './common';
import { TypingLine } from './ThreadView';

/** Messages from one person this close together share one name and face. */
const GROUP_MS = 5 * 60_000;

export function DmView({ dmId }: { dmId: string }) {
  const dm = useApp((s) => s.dms[dmId]);
  const messages = useApp((s) => s.dmMessages[dmId]);
  const loadError = useApp((s) => s.loadErrors[dmId]);
  const me = useApp((s) => s.me);
  const people = useApp((s) => s.people);
  const viewing = useApp((s) => s.presence[dmId]?.viewing);
  const online = useApp((s) => s.online);

  // Looking at a DM reads it, including what arrives while it is open; not while the app is in the background.
  useEffect(() => {
    const look = () => {
      if (document.visibilityState === 'visible' && messages) markDmSeen(dmId);
    };
    look();
    document.addEventListener('visibilitychange', look);
    return () => document.removeEventListener('visibilitychange', look);
  }, [dmId, dm?.updatedAt, Boolean(messages)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!dm || loadError) {
    return (
      <Panel as="main" className="pane-main pane-main--chat">
        <PanelHeader size="lg" />
        <div className="pane-center">
          {loadError || (messages && !dm) ? (
            <Text as="p" tone="secondary">
              This conversation could not be opened.
            </Text>
          ) : (
            <Shimmer>Loading</Shimmer>
          )}
        </div>
      </Panel>
    );
  }

  const others = dm.people.filter((p) => p !== me);
  const name = dmName(dm, me, people);
  const here = others.filter((p) => viewing?.includes(p));
  const on = others.filter((p) => online.includes(p));
  const caption =
    others.length === 1
      ? here.length
        ? 'Online · in this chat'
        : on.length
          ? 'Online'
          : 'Offline'
      : on.length
        ? `${on.map((e) => personName(e, people)).join(', ')} online`
        : 'Nobody else online';

  return (
    <Panel as="main" className="pane-main pane-main--chat">
      <PanelHeader size="lg">
        <InlineStack gap="200" blockAlign="center" className="thread-title">
          <span className="dm-header-faces">
            {others.slice(0, 3).map((p) => (
              <OnlineFace key={p} email={p} size={24} />
            ))}
          </span>
          <BlockStack className="thread-title__text">
            <Text variant="headingMd" as="h1" leading="tight" truncate>
              {name}
            </Text>
            <Text variant="caption" tone="secondary" leading="tight" truncate>
              {caption}
            </Text>
          </BlockStack>
        </InlineStack>
      </PanelHeader>
      <Conversation key={dmId} dmId={dmId} messages={messages} />
      <div className="composer-dock">
        <TypingLine threadId={dmId} />
        <DmComposer key={dmId} placeholder={`Message ${name}`} onSend={(text, files, clientId) => sendDm(dmId, text, files, clientId)} />
      </div>
    </Panel>
  );
}

/** New message: To: picks the people (as in Slack), and the DM you already have with them shows below. */
export function NewMessageView() {
  const me = useApp((s) => s.me);
  const people = useApp((s) => s.people);
  const dms = useApp((s) => s.dms);
  const [to, setTo] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  const online = useApp((s) => s.online);
  const matches = useMemo(() => matchPeople(people, query, [...to, ...(me ? [me] : [])], online), [people, query, to, me, online]);
  const existing = to.length ? dmWith(to, dms, me) : undefined;
  const messages = useApp((s) => (existing ? s.dmMessages[existing.id] : undefined));
  // Also after a reconnect, which drops loaded DMs.
  useEffect(() => {
    if (existing && !messages) void loadDm(existing.id);
  }, [existing?.id, Boolean(messages)]); // eslint-disable-line react-hooks/exhaustive-deps
  // Typing here shows in that DM.
  useEffect(() => {
    setPreviewDm(existing?.id ?? null);
    return () => setPreviewDm(null);
  }, [existing?.id]);
  useEffect(() => setActive(0), [query, to.length]);

  const listOpen = focused && (query.trim() !== '' || to.length === 0);
  const pick = (p: Person) => {
    setTo((cur) => (cur.includes(p.email) ? cur : [...cur, p.email]));
    setQuery('');
    // Ready to write; click To: again to add someone else.
    setFocused(false);
    requestAnimationFrame(() => composer.current?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % matches.length);
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setActive((a) => (a - 1 + matches.length) % matches.length);
    } else if ((e.key === 'Enter' || e.key === 'Tab') && listOpen && matches[active]) {
      e.preventDefault();
      pick(matches[active]!);
    } else if (e.key === 'Backspace' && !query && to.length) {
      setTo((cur) => cur.slice(0, -1));
    } else if (e.key === 'Escape') {
      setFocused(false);
    }
  };

  const send = async (text: string, files: File[], clientId: string) => {
    if (existing) {
      await sendDm(existing.id, text, files, clientId);
      navigate({ name: 'dm', dmId: existing.id });
    } else {
      await sendDmTo(to, text, files, clientId);
    }
  };

  return (
    <Panel as="main" className="pane-main pane-main--chat">
      <PanelHeader size="lg">
        <Text variant="headingMd" as="h1" leading="tight" className="thread-title">
          New message
        </Text>
      </PanelHeader>

      <div className="dm-to">
        <div
          className="dm-to__field"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) e.preventDefault();
            input.current?.focus();
          }}
        >
          <span className="dm-to__label">To:</span>
          {to.map((email) => (
            <span key={email} className="dm-chip">
              <OnlineFace email={email} size={18} />
              {personName(email, people)}
              <button type="button" className="dm-chip__remove" aria-label={`Remove ${personName(email, people)}`} onClick={() => setTo((cur) => cur.filter((x) => x !== email))}>
                ×
              </button>
            </span>
          ))}
          <input
            ref={input}
            className="dm-to__input"
            value={query}
            autoFocus={!isPhone()}
            placeholder={to.length ? '' : 'Name or email of a colleague'}
            aria-label="To"
            role="combobox"
            aria-expanded={listOpen}
            aria-controls="dm-to-list"
            aria-activedescendant={listOpen && matches[active] ? `dm-to-${active}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setFocused(true);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKey}
          />
        </div>
        {listOpen && (
          <div className="dm-to__list" id="dm-to-list" role="listbox" aria-label="People">
            {matches.length === 0 ? (
              <Text as="p" variant="bodySm" tone="secondary" className="dm-to__empty">
                {people.length <= 1 ? 'Nobody else has signed in yet. Colleagues show up here once they have opened Crew.' : 'Nobody by that name.'}
              </Text>
            ) : (
              matches.map((p, i) => (
                <button
                  key={p.email}
                  id={`dm-to-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={cx('dm-to__option', i === active && 'dm-to__option--active')}
                  // Before the input's blur, which would close the list.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(p)}
                >
                  <OnlineFace email={p.email} size={22} />
                  <span className="dm-to__name">{p.name}</span>
                  <span className="dm-to__email">{p.email}</span>
                  <span className={cx('dm-to__status', online.includes(p.email) && 'dm-to__status--on')}>{online.includes(p.email) ? 'Online' : 'Offline'}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {existing ? (
        <Conversation key={existing.id} dmId={existing.id} messages={messages} />
      ) : (
        <div className="pane-scroll">
          {to.length ? <Intro with={to} /> : null}
        </div>
      )}
      <div className="composer-dock">
        <DmComposer
          ref={composer}
          placeholder={to.length ? `Message ${to.map((e) => personName(e, people)).join(', ')}` : 'Start a new message'}
          disabled={!to.length}
          autoFocus={false}
          onSend={send}
        />
      </div>
    </Panel>
  );
}

/** People matching what was typed in To: names starting with it first, then names or emails containing it. With nothing typed, who is online first. */
function matchPeople(people: Person[], query: string, skip: string[], online: string[]): Person[] {
  const q = query.trim().toLowerCase();
  const left = people.filter((p) => !skip.includes(p.email));
  if (!q) return [...left].sort((a, b) => Number(online.includes(b.email)) - Number(online.includes(a.email)) || a.name.localeCompare(b.name));
  const starts = left.filter((p) => p.name.toLowerCase().startsWith(q) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
  const within = left.filter((p) => !starts.includes(p) && (p.name.toLowerCase().includes(q) || p.email.includes(q)));
  return [...starts, ...within];
}

/** The top of a conversation: who it is with. */
function Intro({ with: others }: { with: string[] }) {
  const people = useApp((s) => s.people);
  const names = others.map((e) => personName(e, people));
  return (
    <div className="dm-intro">
      <span className="dm-intro__faces">
        {others.slice(0, 3).map((e) => (
          <PersonFace key={e} email={e} size={56} />
        ))}
      </span>
      <Text as="p" variant="headingMd">
        {names.join(', ')}
      </Text>
      <Text as="p" tone="secondary">
        This is the start of your conversation with {names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}. Only you {names.length > 1 ? 'all' : 'two'} see it.
      </Text>
    </div>
  );
}

/** A DM's messages as chat bubbles: mine on the right, theirs on the left with a face and name. */
function Conversation({ dmId, messages }: { dmId: string; messages: DmMessage[] | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const hasMore = useApp((s) => s.dmHasMore[dmId]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);
  // Earlier messages go on top; what you were reading stays where it was.
  const older = async () => {
    const el = scroller.current;
    const before = el?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      await loadOlderDm(dmId);
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - before;
      });
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <div
      className="pane-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {!messages ? (
        <div className="pane-center">
          <Shimmer>Loading</Shimmer>
        </div>
      ) : (
        <div className="chat dm-chat">
          {hasMore ? (
            <Button variant="plain" size="slim" className="dm-older" disabled={loadingOlder} onClick={() => void older()}>
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </Button>
          ) : null}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            // A name and face where someone starts talking; not on every line of a quick run.
            const grouped = Boolean(prev && prev.by === m.by && m.ts - prev.ts < GROUP_MS);
            return <Bubble key={m.id} message={m} grouped={grouped} />;
          })}
        </div>
      )}
    </div>
  );
}

function Bubble({ message: m, grouped }: { message: DmMessage; grouped: boolean }) {
  const me = useApp((s) => s.me);
  const name = useApp((s) => personName(m.by, s.people));
  const mine = m.by === me;
  return (
    <div className={cx(mine ? 'owner-message' : 'person-message', grouped && 'dm-grouped')} title={clock(m.ts)}>
      {!mine && !grouped ? (
        <span className="person-message__who">
          <PersonFace email={m.by} size={16} />
          <Text as="span" variant="caption" weight="medium" tone="secondary">
            {name} · {clock(m.ts)}
          </Text>
        </span>
      ) : null}
      <div className="bubble">
        {m.attachments?.length ? <MessageImages threadId={m.dmId} attachments={m.attachments} /> : null}
        {m.text ? <Markdown text={m.text} /> : null}
      </div>
    </div>
  );
}

/** Write a message: Enter sends (on a phone, the button), images by paste, drop or the clip. */
const DmComposer = forwardRef<
  HTMLTextAreaElement,
  { placeholder: string; disabled?: boolean; autoFocus?: boolean; onSend: (text: string, files: File[], clientId: string) => Promise<void> }
>(function DmComposer({ placeholder, disabled, autoFocus = true, onSend }, outer) {
  const online = useApp((s) => s.connection === 'online');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const images = useAttachments();
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ref.current!, []);
  // Not on a phone: the keyboard would come up over the conversation you just opened.
  useEffect(() => {
    if (autoFocus && !isPhone()) ref.current?.focus();
  }, [autoFocus]);

  // One id per message written: a retry after a lost answer is the same message, not a second one.
  const clientId = useRef(newClientId());
  const canSend = (text.trim() !== '' || images.files.length > 0) && !busy && online && !disabled;
  const submit = async () => {
    if (!canSend) return;
    const sentText = text;
    const sentFiles = images.files;
    setBusy(true);
    setError('');
    try {
      await onSend(sentText.trim(), sentFiles, clientId.current);
      clientId.current = newClientId();
      // Only what was sent goes: anything written while it was sending stays.
      setText((t) => (t === sentText ? '' : t));
      if (images.files === sentFiles) images.clear();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BlockStack gap="200" {...images.dropProps}>
      {error || images.error ? (
        <Text as="p" variant="bodySm" tone="critical" className="typing-line">
          {error || images.error}
        </Text>
      ) : null}
      <AttachmentTray files={images.files} onRemove={images.remove} />
      <Composer
        ref={ref}
        enterSends={!isPhoneTouch()}
        label={placeholder}
        value={text}
        onChange={(t) => {
          setText(t);
          if (t.trim()) sendTyping();
        }}
        onSubmit={() => void submit()}
        onPaste={images.onPaste}
        leading={images.button}
        disabled={!online || disabled}
        placeholder={placeholder}
        trailing={<IconButton tone="primary" icon="arrowUp" label="Send" disabled={!canSend} onClick={() => void submit()} />}
      />
    </BlockStack>
  );
});

function newClientId(): string {
  return crypto.randomUUID();
}
