import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CrewEvent, Session, TurnStatus } from '@crew/protocol';
import {
  Badge,
  BlockStack,
  Button,
  Card,
  CardDetails,
  CardFooter,
  CardHeader,
  CardRow,
  ChipSelect,
  Composer,
  Disclosure,
  Icon,
  IconButton,
  InlineStack,
  Panel,
  PanelHeader,
  Shimmer,
  Text,
  TextField,
  cx,
  type BadgeTone,
  type IconName,
} from '@crew/ui';
import {
  archiveThread,
  editQueuedMessage,
  isPhone,
  dmTitle,
  markDmSeen,
  mentionedPeople,
  navigate,
  openAsPreview,
  personName,
  releaseThread,
  sendTyping,
  removeQueuedMessage,
  resolveInbox,
  resumeSession,
  runAgain,
  selectPreview,
  sendMessage,
  setPreviewWidth,
  stopSession,
  togglePreview,
  useApp,
  type ThreadData,
} from '../store';
import { isPhoneTouch } from '../swipe';
import { AttachmentTray, MessageImages, useAttachments } from './attachments';
import { PaneResizer } from './PaneResizer';
import {
  Elapsed,
  Markdown,
  PersonFace,
  markMentions,
  RoleFace,
  RoleFaces,
  ago,
  clock,
  duration,
  engineName,
  oneLine,
  usageLabel,
  usageTitle,
  useNow,
  usePersonName,
  useRoleLabel,
  useRoleLabels,
} from './common';
import { ApprovalCard } from './ApprovalCard';
import { PreviewPanel, usePreviewDocs } from './PreviewPanel';
import { QuestionAnswer } from './QuestionAnswer';
import { ShareButton } from './ShareDialog';

type Ev<T extends CrewEvent['type']> = Extract<CrewEvent, { type: T }>;

type Item =
  /** answer: for a needs_you card, the owner's reply to it (shown in the card, not as a bubble). */
  | { kind: 'event'; event: CrewEvent; answer?: string }
  | { kind: 'work'; id: string; events: Array<Ev<'tool_call'> | Ev<'thinking'>> }
  | { kind: 'subagents'; id: string; starts: Ev<'subagent_started'>[] };

/** Crew's own tools show up as cards, not as tool calls. */
const HIDDEN_TOOLS = /(^|__)(show_preview|ask_owner|save_artifact)$/;

/** The lead calls a specialist through a tool named after it (store-manager → store_manager). */
function isSubagentTool(name: string, agents: Record<string, string>): boolean {
  const tool = name.replace(/^mcp__crew__/, '');
  return Object.keys(agents).some((a) => a.replace(/-/g, '_') === tool);
}

function buildItems(events: CrewEvent[], session: Session, agents: Record<string, string>): Item[] {
  const items: Item[] = [];
  const chat = chatEvents(events, session);
  // A reply to a question card shows inside that card. Not when it carries
  // images or was never delivered: then it stays a bubble of its own.
  const asked = new Set(chat.flatMap((e) => (e.type === 'needs_you' ? [e.inboxId] : [])));
  const answers = new Map<string, { eventId: number; text: string }>();
  for (const e of chat) {
    if (e.type !== 'message' || !e.replyTo || !asked.has(e.replyTo) || answers.has(e.replyTo) || e.attachments?.length) continue;
    if (deliveryOf(e, events, session).state === 'dropped') continue;
    answers.set(e.replyTo, { eventId: e.id, text: e.text });
  }
  const inCard = new Set([...answers.values()].map((a) => a.eventId));
  // Turns the owner wrote into (a steered message), whatever order the chat shows them in.
  const steered = new Set(events.flatMap((e) => (e.type === 'message' && e.role === 'user' && e.delivery === 'steer' && e.turnId ? [e.turnId] : [])));
  // The turn that just asked a question, until the agent uses a tool.
  let askedIn: string | null = null;
  for (const e of chat) {
    // The agent was told to stop after asking: its text straight after the
    // card, in the same turn, only restates the question. Not in a turn the
    // owner wrote into (the text may answer them) and not after a tool call.
    const restates =
      e.type === 'message' && e.role === 'assistant' && askedIn !== null && e.turnId === askedIn && !steered.has(askedIn);
    if (e.type === 'needs_you') askedIn = e.turnId ?? null;
    else if (e.type === 'tool_call' || (e.type === 'message' && e.role === 'user')) askedIn = null;
    if (restates) continue;
    if (e.type === 'message' && inCard.has(e.id)) continue; // shown in its card
    if (e.type === 'needs_you') {
      items.push({ kind: 'event', event: e, answer: answers.get(e.inboxId)?.text });
      continue;
    }
    if (e.type === 'tool_result' || e.type === 'subagent_done') continue; // shown inside their call / card
    if (e.type === 'message_delivery') continue; // shown as the owner message's label
    if (e.type === 'tool_call' && (HIDDEN_TOOLS.test(e.name) || isSubagentTool(e.name, agents))) continue;
    if (e.type === 'turn_done' && e.status === 'done') continue;
    if (e.type === 'turn_started' && !e.callerRole && !e.resumed) continue;
    const last = items.at(-1);
    if (e.type === 'tool_call' || e.type === 'thinking') {
      if (last?.kind === 'work') last.events.push(e);
      else items.push({ kind: 'work', id: `work-${e.id}`, events: [e] });
      continue;
    }
    if (e.type === 'subagent_started') {
      if (last?.kind === 'subagents') last.starts.push(e);
      else items.push({ kind: 'subagents', id: `sub-${e.id}`, starts: [e] });
      continue;
    }
    items.push({ kind: 'event', event: e });
  }
  return items;
}

function toolLabel(name: string, input: unknown): string {
  const short = name.replace(/^mcp__/, '').replace(/__/g, '.');
  const i = (input ?? {}) as Record<string, unknown>;
  const arg = i.file_path ?? i.pattern ?? i.query ?? i.command ?? i.url ?? i.skill ?? i.description;
  return arg ? `${short} ${oneLine(String(arg).replace(/^\/bin\/zsh -lc /, ''), 80)}` : short;
}

// ---------------------------------------------------------------------------
// "Worked 6s ›": the agent's own tool calls and thinking, collapsed.

function WorkGroup({ events, data, sessionRunning, isLast }: { events: Array<Ev<'tool_call'> | Ev<'thinking'>>; data: ThreadData; sessionRunning: boolean; isLast: boolean }) {
  const results = useMemo(() => {
    const m = new Map<string, Ev<'tool_result'>>();
    for (const e of data.events) if (e.type === 'tool_result') m.set(e.callId, e);
    return m;
  }, [data.events]);
  const calls = events.filter((e): e is Ev<'tool_call'> => e.type === 'tool_call');
  const pending = calls.some((c) => !results.has(c.callId));
  const running = sessionRunning && isLast && pending;
  const end = Math.max(...events.map((e) => e.ts), ...calls.map((c) => results.get(c.callId)?.ts ?? 0));
  const failed = calls.filter((c) => results.get(c.callId)?.isError).length;

  const summary = running ? (
    <>
      Working{calls.length ? ` · ${calls.length} ${calls.length === 1 ? 'step' : 'steps'}` : ''}
    </>
  ) : (
    <>
      Worked {duration(Math.max(1000, end - events[0]!.ts))}
      {calls.length ? ` · ${calls.length} ${calls.length === 1 ? 'step' : 'steps'}` : ''}
      {failed ? <Text as="span" variant="bodyLg" tone="critical">{` · ${failed} failed`}</Text> : null}
    </>
  );

  return (
    <Disclosure summary={summary}>
      <BlockStack gap="200" className="work-details">
        {events.map((e) =>
          e.type === 'thinking' ? (
            <div key={e.id} className="work-thinking">
              <Markdown text={e.text} />
            </div>
          ) : (
            <div key={e.id} className="work-step">
              <Text variant="caption" tone="emphasis" className="mono" truncate>
                {toolLabel(e.name, e.input)}
              </Text>
              {results.get(e.callId)?.output ? (
                <pre className={results.get(e.callId)!.isError ? 'work-output work-output--error' : 'work-output'}>
                  {results.get(e.callId)!.output.slice(0, 2000)}
                </pre>
              ) : null}
            </div>
          ),
        )}
      </BlockStack>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Grouped subagent card: "3 subagents · 2 working · 4m".

type SubStatus = TurnStatus | 'queued';

function subagentState(start: Ev<'subagent_started'>, data: ThreadData) {
  const done = data.events.find((e): e is Ev<'subagent_done'> => e.type === 'subagent_done' && e.childTurnId === start.childTurnId);
  const session = data.sessions[start.childSessionId];
  const status: SubStatus = done
    ? done.status
    : session?.status === 'interrupted'
      ? 'interrupted'
      : session?.status === 'error'
        ? 'error'
        : session?.status === 'queued'
          ? 'queued'
          : 'running';
  return { done, session, status };
}

const STATUS_BADGE: Record<SubStatus, { tone: BadgeTone; label: string }> = {
  running: { tone: 'neutral', label: 'Working' },
  queued: { tone: 'subtle', label: 'Queued' },
  done: { tone: 'subtle', label: 'Done' },
  interrupted: { tone: 'caution', label: 'Interrupted' },
  error: { tone: 'critical', label: 'Failed' },
  cancelled: { tone: 'subtle', label: 'Stopped' },
};

/** What a Crew tool call means, in words, for the live line on a card. */
function crewToolLine(name: string, agents: Record<string, string>): string | undefined {
  if (isSubagentTool(name, agents)) return 'Asking a colleague';
  if (/(^|__)save_artifact$/.test(name)) return 'Saving the work';
  if (/(^|__)show_preview$/.test(name)) return 'Putting a draft in the preview';
  if (/(^|__)ask_owner$/.test(name)) return 'Asking you a question';
  return undefined;
}

function SubagentRow({ threadId, start, data }: { threadId: string; start: Ev<'subagent_started'>; data: ThreadData }) {
  const label = useRoleLabel(start.role);
  const labels = useRoleLabels();
  const [open, setOpen] = useState(false);
  const now = useNow(1000, !open);
  const showSpend = useApp((s) => s.showSpend);
  const { done, status } = subagentState(start, data);
  const waiting = useApp((s) => Object.values(s.inbox).some((i) => i.kind === 'approval' && i.sessionId === start.childSessionId));

  const childEvents = data.events.filter((e) => e.turnId === start.childTurnId);
  const last = [...childEvents].reverse().find((e) => e.type === 'tool_call' || e.type === 'message' || e.type === 'subagent_started');
  const nested = childEvents.filter((e): e is Ev<'subagent_started'> => e.type === 'subagent_started');

  let line: string;
  if (waiting && (status === 'running' || status === 'queued')) line = 'Waiting for your approval';
  else if (status === 'running' || status === 'queued') {
    if (last?.type === 'tool_call') line = crewToolLine(last.name, labels) ?? `Using ${toolLabel(last.name, last.input)}`;
    else if (last?.type === 'message') line = oneLine(last.text, 120);
    else if (last?.type === 'subagent_started') line = `Asked ${labels[last.role] ?? last.role}`;
    else line = oneLine(start.brief, 120);
  } else if (done?.result) line = oneLine(done.result, 160);
  else line = oneLine(start.brief, 120);

  const badge = STATUS_BADGE[status];
  const time = status === 'running' ? duration(now - start.ts) : done && status === 'done' ? duration(done.durationMs) : '';
  const childUsage = data.events.find((e): e is Ev<'turn_done'> => e.type === 'turn_done' && e.turnId === start.childTurnId)?.usage;
  const spent = showSpend ? usageLabel(childUsage) : '';
  const detailsId = `sub-${start.childTurnId}`;

  const openResult = () =>
    openAsPreview(threadId, {
      id: `result-${start.childTurnId}`,
      title: `${label}: result`,
      format: 'markdown',
      content: done!.result,
      from: start.role,
      ts: done!.ts,
    });
  const stepIn = () => navigate({ name: 'thread', threadId, sessionId: start.childSessionId });

  return (
    <>
      <CardRow>
        <RoleFace role={start.role} size="lg" decorative />
        <button type="button" className="row-toggle cr-focusable" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
          <Text as="span" variant="bodyLg" weight="medium" leading="snug" truncate>
            {label}
          </Text>
          <Text as="span" variant="bodySm" tone="secondary" leading="snug" truncate>
            {line}
          </Text>
        </button>
        <Badge tone={badge.tone} title={showSpend ? usageTitle(childUsage) || undefined : undefined}>
          {badge.label}
          {time ? ` · ${time}` : ''}
          {spent ? ` · ${spent}` : ''}
        </Badge>
        {status === 'running' || status === 'queued' ? (
          <IconButton icon="stop" label={`Stop ${label}`} iconSize={13} onClick={() => void stopSession(start.childSessionId)} />
        ) : null}
        {status === 'interrupted' || status === 'error' ? (
          <Button size="slim" variant="tertiary" icon="play" onClick={() => void resumeSession(start.childSessionId)}>
            {status === 'interrupted' ? 'Resume' : 'Retry'}
          </Button>
        ) : null}
        {done?.result && status === 'done' ? (
          <>
            <Button size="slim" variant="tertiary" onClick={stepIn}>
              Step in
            </Button>
            <Button size="slim" onClick={openResult}>
              Open
            </Button>
          </>
        ) : (
          <Button size="slim" onClick={stepIn}>
            Step in
          </Button>
        )}
      </CardRow>
      {open ? (
        <CardDetails id={detailsId}>
          <BlockStack gap="200">
            <Text variant="label" tone="secondary">
              Brief from {labels[data.sessions[start.sessionId]?.role ?? ''] ?? 'the GM'} · {engineName(start.engine)} · {start.model}
            </Text>
            <Markdown text={start.brief} className="md--small" />
            {nested.length ? (
              <InlineStack gap="150" wrap>
                <Text variant="caption" tone="secondary">
                  Asked
                </Text>
                {nested.map((n) => (
                  <InlineStack key={n.id} gap="100">
                    <RoleFace role={n.role} size="xs" decorative />
                    <Text variant="caption">{labels[n.role] ?? n.role}</Text>
                  </InlineStack>
                ))}
              </InlineStack>
            ) : null}
            {done && done.status !== 'done' && done.result ? (
              <Text variant="bodySm" tone="critical">
                {oneLine(done.result, 400)}
              </Text>
            ) : null}
          </BlockStack>
        </CardDetails>
      ) : null}
    </>
  );
}

function SubagentGroup({ threadId, starts, data }: { threadId: string; starts: Ev<'subagent_started'>[]; data: ThreadData }) {
  const states = starts.map((s) => ({ start: s, ...subagentState(s, data) }));
  const working = states.filter((s) => s.status === 'running' || s.status === 'queued').length;
  const stalled = states.filter((s) => s.status === 'interrupted' || s.status === 'error').length;
  const first = Math.min(...starts.map((s) => s.ts));
  const lastEnd = Math.max(...states.map((s) => s.done?.ts ?? s.start.ts));
  const now = useNow(1000, working > 0);
  return (
    <Card>
      <CardHeader>
        <Text as="span" variant="bodySm" weight="semibold">
          {starts.length} {starts.length === 1 ? 'subagent' : 'subagents'}
        </Text>
        <Text as="span" variant="bodySm" tone="secondary">
          {working
            ? `${working} working · ${duration(now - first)}`
            : stalled
              ? `${stalled} ${stalled === 1 ? 'needs' : 'need'} a restart · ${starts.length - stalled} done`
              : `done in ${duration(lastEnd - first)}`}
        </Text>
      </CardHeader>
      {starts.map((s) => (
        <SubagentRow key={s.id} threadId={threadId} start={s} data={data} />
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// "Needs you": the approval card, used for ask_owner questions.

function NeedsYouCard({ threadId, event, role, answer }: { threadId: string; event: Ev<'needs_you'>; role: string; answer?: string }) {
  const open = useApp((s) => Boolean(s.inbox[event.inboxId]));
  const label = useRoleLabel(role);
  return (
    <Card variant={open ? 'elevated' : 'subtle'} padded={!open}>
      <BlockStack gap="250">
        <Text variant="label" tone="secondary">
          {open ? `${label} asks` : `${label} asked`}
        </Text>
        <Markdown text={event.question} className="md--question" />
        {!open && answer ? (
          <div className="answer-given">
            <Icon name="check" size={13} />
            <Markdown text={answer} />
          </div>
        ) : null}
        {open ? (
          <QuestionAnswer
            threadId={threadId}
            sessionId={event.sessionId}
            inboxId={event.inboxId}
            options={event.options}
            recommended={event.recommended}
            multiSelect={event.multiSelect}
            actions={
              <Button variant="tertiary" onClick={() => void resolveInbox(event.inboxId)}>
                Dismiss
              </Button>
            }
          />
        ) : null}
      </BlockStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Approvals in the thread. The Inbox has the same items; deciding in either place settles both.

/** Where the agent asked: the card while it waits; afterwards the approval_done line says how it went. */
function InlineApproval({ inboxId }: { inboxId: string }) {
  const item = useApp((s) => s.inbox[inboxId]);
  return item?.kind === 'approval' ? <ApprovalCard item={item} /> : null;
}

/**
 * Approvals other agents in this thread are waiting on (a specialist the GM
 * asked, like the Developer), above the composer, so you see them without
 * stepping in or opening the Inbox.
 */
function OtherApprovals({ threadId, session, rootId }: { threadId: string; session: Session; rootId: string }) {
  const inbox = useApp((s) => s.inbox);
  const items = useMemo(
    () =>
      Object.values(inbox)
        .filter((i) => i.kind === 'approval' && i.threadId === threadId && i.sessionId !== session.id)
        .sort((a, b) => a.createdAt - b.createdAt),
    [inbox, threadId, session.id],
  );
  if (!items.length) return null;
  return (
    <BlockStack gap="200" className="thread-approvals">
      {items.map((item) => (
        <ApprovalCard
          key={item.id}
          item={item}
          extra={
            <Button variant="tertiary" onClick={() => navigate({ name: 'thread', threadId, sessionId: item.sessionId === rootId ? undefined : item.sessionId })}>
              Step in
            </Button>
          }
        />
      ))}
    </BlockStack>
  );
}

// ---------------------------------------------------------------------------

function StatusLine({ tone = 'secondary', icon, children }: { tone?: 'secondary' | 'caution' | 'critical'; icon?: IconName; children: ReactNode }) {
  return (
    <InlineStack gap="150" className={`status-line status-line--${tone}`}>
      {icon ? <Icon name={icon} size={13} /> : null}
      <Text as="span" variant="bodySm" tone={tone}>
        {children}
      </Text>
    </InlineStack>
  );
}

type Delivery = 'steering' | 'queued' | 'on_resume' | 'dropped' | 'removed' | null;

interface DeliveryInfo {
  state: Delivery;
  /** The text as the agent gets it (the owner may have edited it while it waited). */
  text: string;
  /** Where the agent picked it up: the turn that started with it, or the moment it read it. */
  landedAt: number | null;
}

/**
 * Where an owner message sent while the agent was working stands. Steered: it
 * went into the running turn and waits for the agent's next step. Queued: it
 * waits for the turn it is tagged with to start. Null once the agent has it.
 */
function deliveryOf(event: Ev<'message'>, events: CrewEvent[], session: Session | undefined): DeliveryInfo {
  const info: DeliveryInfo = { state: null, text: event.text, landedAt: null };
  // Held (people tagged each other): part of the conversation, never a waiting chip.
  if (event.delivery === 'held') return info;
  if (event.role !== 'user' || !event.turnId || !event.delivery) return info;
  let mode = event.delivery;
  let turnId = event.turnId;
  let turnDone: TurnStatus | null = null;
  for (const e of events) {
    if (e.id <= event.id || e.sessionId !== event.sessionId) continue;
    if (e.type === 'message_delivery' && e.messageId === event.id) {
      if (e.state === 'read') return { ...info, landedAt: e.id };
      if (e.state === 'removed') return { ...info, state: 'removed' };
      if (e.state === 'edited') info.text = e.text ?? info.text;
      if (e.state === 'requeued') {
        mode = 'queue';
        turnId = e.nextTurnId ?? turnId;
      }
      continue;
    }
    if (e.turnId !== turnId) continue;
    if (mode === 'queue' && e.type === 'turn_started') return { ...info, landedAt: e.id };
    if (mode === 'queue' && e.type === 'status') return { ...info, state: 'dropped' };
    if (e.type === 'turn_done') turnDone = e.status;
  }
  if (mode === 'steer') {
    // Stopped before the agent read it; otherwise its fate is still being settled.
    if (turnDone === 'cancelled') return { ...info, state: 'dropped' };
    return { ...info, state: turnDone ? null : 'steering' };
  }
  const status = session?.status;
  return { ...info, state: status === 'interrupted' ? 'on_resume' : status === 'running' || status === 'queued' ? 'queued' : 'dropped' };
}

/** Owner messages the agent does not have yet: shown above the composer. */
function waitingMessages(events: CrewEvent[], session: Session): Array<{ event: Ev<'message'>; info: DeliveryInfo }> {
  const out: Array<{ event: Ev<'message'>; info: DeliveryInfo }> = [];
  for (const e of events) {
    if (e.type !== 'message' || e.sessionId !== session.id || !e.delivery) continue;
    const info = deliveryOf(e, events, session);
    if (info.state === 'steering' || info.state === 'queued' || info.state === 'on_resume') out.push({ event: e, info });
  }
  return out;
}

/**
 * The chat's events in display order. A message sent while the agent worked
 * is left out while it waits (it is a chip above the composer), and then shows
 * where the agent picked it up, with the text it got.
 */
function chatEvents(events: CrewEvent[], session: Session): CrewEvent[] {
  const placed: Array<{ key: number; event: CrewEvent }> = [];
  for (const e of events) {
    if (e.sessionId !== session.id) continue;
    if (e.type === 'message' && e.delivery) {
      const info = deliveryOf(e, events, session);
      if (info.state === 'dropped') placed.push({ key: e.id, event: { ...e, text: info.text } });
      else if (info.state === null) placed.push({ key: (info.landedAt ?? e.id) - 0.5, event: { ...e, text: info.text } });
      continue;
    }
    placed.push({ key: e.id, event: e });
  }
  return placed.sort((a, b) => a.key - b.key).map((p) => p.event);
}

function OwnerMessage({ threadId, event, session }: { threadId: string; event: Ev<'message'>; session: Session }) {
  const events = useApp((s) => s.details[threadId]?.events);
  const dropped = events ? deliveryOf(event, events, session).state === 'dropped' : false;
  const me = useApp((s) => s.me);
  const colleague = me && event.by && event.by !== me ? event.by : null;
  const name = usePersonName(colleague);
  const people = useApp((s) => s.people);
  const names = useMemo(() => people.map((p) => p.name), [people]);
  return (
    <div className={colleague ? 'person-message' : 'owner-message'}>
      {colleague ? (
        <span className="person-message__who">
          <PersonFace email={colleague} size={16} />
          <Text as="span" variant="caption" weight="medium" tone="secondary">
            {name} · {clock(event.ts)}
          </Text>
        </span>
      ) : null}
      <div className="bubble">
        {event.attachments?.length ? <MessageImages threadId={threadId} attachments={event.attachments} /> : null}
        <Markdown text={markMentions(event.text, names)} />
      </div>
      {dropped ? (
        <InlineStack gap="100" className="delivery-note">
          <Icon name="alert" size={12} />
          <Text as="span" variant="caption" tone="secondary">
            Not delivered · the work was stopped
          </Text>
        </InlineStack>
      ) : null}
    </div>
  );
}

/** Messages waiting for the agent, above the composer. Queued ones can still be edited or taken back. */
function WaitingMessages({ data, session }: { data: ThreadData; session: Session }) {
  const label = useRoleLabel(session.role);
  const waiting = useMemo(() => waitingMessages(data.events, session), [data.events, session]);
  if (!waiting.length) return null;
  return (
    <BlockStack gap="100" className="waiting-list">
      {waiting.map(({ event, info }) => (
        <WaitingChip key={event.id} event={event} info={info} label={label} />
      ))}
    </BlockStack>
  );
}

function WaitingChip({ event, info, label }: { event: Ev<'message'>; info: DeliveryInfo; label: string }) {
  const online = useApp((s) => s.connection === 'online');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(info.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status =
    info.state === 'steering'
      ? `Sending · ${label} reads this at the next step`
      : info.state === 'queued'
        ? `Queued · ${label} gets this when the current turn ends`
        : `Waiting · ${label} gets this on Resume`;
  const canChange = info.state === 'queued' && online;
  return (
    <div className="waiting-chip">
      <Icon name="clock" size={13} />
      <BlockStack gap="050" className="grow">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) void act(() => editQueuedMessage(event.id, draft.trim()));
            }}
          >
            <TextField variant="message" label="Edit message" value={draft} onChange={setDraft} disabled={busy} />
          </form>
        ) : (
          <Text as="span" variant="bodySm" truncate>
            {info.text}
          </Text>
        )}
        <Text as="span" variant="caption" tone={error ? 'critical' : 'secondary'}>
          {error || status}
        </Text>
      </BlockStack>
      {canChange ? (
        editing ? (
          <InlineStack gap="100">
            <Button size="slim" variant="tertiary" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="slim" variant="primary" onClick={() => void act(() => editQueuedMessage(event.id, draft.trim()))} disabled={busy || !draft.trim()}>
              Save
            </Button>
          </InlineStack>
        ) : (
          <InlineStack gap="100">
            <Button
              size="slim"
              variant="tertiary"
              onClick={() => {
                setDraft(info.text);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button size="slim" variant="tertiary" onClick={() => void act(() => removeQueuedMessage(event.id))} disabled={busy}>
              Remove
            </Button>
          </InlineStack>
        )
      ) : null}
    </div>
  );
}

function EventRow({ threadId, event, session, answer }: { threadId: string; event: CrewEvent; session: Session; answer?: string }) {
  const callerLabel = useRoleLabel(event.type === 'turn_started' ? (event.callerRole ?? '') : '');
  const selectedPreview = useApp((s) => s.preview[threadId]);
  switch (event.type) {
    case 'message':
      if (event.role === 'user') return <OwnerMessage threadId={threadId} event={event} session={session} />;
      return <Markdown text={event.text} />;
    case 'needs_you':
      return <NeedsYouCard threadId={threadId} event={event} role={session.role} answer={answer} />;
    case 'approval':
      return <InlineApproval inboxId={event.inboxId} />;
    case 'approval_done':
      return (
        <StatusLine tone={event.approved ? 'secondary' : 'caution'} icon={event.approved ? 'check' : 'alert'}>
          {event.approved ? 'Approved' : event.stopped ? 'Not decided, the work was stopped' : 'Denied'}: {event.toolName.replace(/^mcp__crew__/, '')}
        </StatusLine>
      );
    case 'preview':
      return (
        <Card>
          <CardRow>
            <span className="doc-icon">
              <Icon name="document" size={14} />
            </span>
            <BlockStack className="grow">
              <Text as="span" variant="bodyLg" weight="medium" leading="snug" truncate>
                {event.title}
              </Text>
              <Text as="span" variant="bodySm" tone="secondary" leading="snug">
                Draft in the preview · not published
              </Text>
            </BlockStack>
            <Button size="slim" onClick={() => selectPreview(threadId, event.previewId)} aria-pressed={selectedPreview === event.previewId}>
              Open
            </Button>
          </CardRow>
        </Card>
      );
    case 'turn_started':
      if (event.callerRole) {
        return (
          <InlineStack gap="250" blockAlign="start">
            <RoleFace role={event.callerRole} size="xl" />
            <BlockStack gap="050" className="grow">
              <Text variant="caption" tone="secondary">
                <strong className="author">Brief from {callerLabel}</strong> · {clock(event.ts)}
              </Text>
              <Markdown
                text={event.prompt
                  .replace(/^\(.*?\)\n\n/, '')
                  .replace(/^Brief from [^\n]*\n\n/, '')
                  .replace(/\n\nYour final message is returned[^\n]*$/, '')}
              />
            </BlockStack>
          </InlineStack>
        );
      }
      return (
        <StatusLine icon="play">
          Resumed after a restart
        </StatusLine>
      );
    case 'turn_done':
      return (
        <StatusLine tone={event.status === 'interrupted' || event.status === 'cancelled' ? 'caution' : 'critical'} icon="alert">
          {event.status === 'interrupted' ? 'Interrupted' : event.status === 'cancelled' ? 'Stopped' : 'Failed'}
          {event.error ? `: ${oneLine(event.error, 300)}` : ''}
        </StatusLine>
      );
    case 'status':
      return <StatusLine>{event.text}</StatusLine>;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Composer: "Reply, or @ an agent", with the agent chip that also does Step in.

function sessionOptions(data: ThreadData, rootId: string, labels: Record<string, string>) {
  const list = Object.values(data.sessions).sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt);
  const seen = new Map<string, number>();
  return list.map((s) => {
    const n = (seen.get(s.role) ?? 0) + 1;
    seen.set(s.role, n);
    const base = labels[s.role] ?? s.role;
    return { value: s.id, label: s.id === rootId ? base : `${n > 1 ? `${base} ${n}` : base}`, role: s.role };
  });
}

type SessionOption = ReturnType<typeof sessionOptions>[number];

/**
 * Exact match of a known agent name right after "@", ending at a space or the
 * end of the text. The longest name wins ("@store manager" over "@store").
 * Several sessions of one role: the one you are talking to, otherwise ask.
 */
export function resolveMention(
  body: string,
  options: SessionOption[],
  currentSessionId: string,
): { sessionId: string; rest: string } | { error: string } {
  const lower = body.toLowerCase();
  let best: { key: string; matches: SessionOption[] } | undefined;
  for (const o of options) {
    const keys = new Set([o.role, o.label.toLowerCase(), o.label.toLowerCase().replace(/\s+/g, '-')]);
    for (const key of keys) {
      const end = 1 + key.length;
      if (!lower.startsWith('@' + key) || (lower.length > end && !/\s/.test(lower[end]!))) continue;
      if (!best || key.length > best.key.length) best = { key, matches: [o] };
      else if (key === best.key && !best.matches.includes(o)) best.matches.push(o);
    }
  }
  if (!best) {
    const name = /^@(\S+)/.exec(body)?.[1] ?? '';
    return { error: `No agent called @${name} in this thread. Pick one with the Talk to menu.` };
  }
  const rest = body.slice(1 + best.key.length).trim();
  if (!rest) return { error: 'Write a message after the @ name.' };
  const pick = best.matches.length === 1 ? best.matches[0] : best.matches.find((m) => m.value === currentSessionId);
  if (!pick) return { error: `There are several ${best.matches[0]!.label} sessions here. Pick one with the Talk to menu.` };
  return { sessionId: pick.value, rest };
}

function ThreadComposer({ threadId, session, data, rootId }: { threadId: string; session: Session; data: ThreadData; rootId: string }) {
  const [text, setText] = useState('');
  const images = useAttachments();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const labels = useRoleLabels();
  const label = labels[session.role] ?? session.role;
  const online = useApp((s) => s.connection === 'online');
  const working = session.status === 'running' || session.status === 'queued';
  const ref = useRef<HTMLTextAreaElement>(null);
  const options = useMemo(() => sessionOptions(data, rootId, labels), [data, rootId, labels]);

  // Not on a phone: the keyboard would come up over the conversation you just opened.
  useEffect(() => {
    if (!isPhone()) ref.current?.focus();
  }, [session.id]);

  const go = (sessionId: string) => navigate({ name: 'thread', threadId, sessionId: sessionId === rootId ? undefined : sessionId });

  const me = useApp((s) => s.me);
  const people = useApp((s) => s.people);
  // A DM before anyone called an agent: messages go to people only.
  const dmQuiet = Boolean(data.thread.dm) && !Object.values(data.turns).some((t) => t.sessionId === rootId);
  const picker = useMentionPicker(text, setText, ref, options, me ? people.filter((p) => p.email !== me) : []);

  const submit = async () => {
    let body = text.trim();
    if ((!body && !images.files.length) || busy) return;
    // People tagged (@Juliette): with nobody else called on, the agent waits for them.
    const mentions = me ? mentionedPeople(body, people, me) : [];
    // "@store-manager …" or "@Store manager …" sends to that agent's session in this thread.
    let target = session;
    let toAgent = options.some((o) => new RegExp(`(^|[^\\w@])@${o.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(body));
    if (body.startsWith('@')) {
      const resolved = resolveMention(body, options, session.id);
      if ('error' in resolved) {
        // "@Juliette, …" starts with a person, not an agent: that is fine.
        const first = (/^@([^\s,.:;!?]+)/.exec(body)?.[1] ?? '').toLowerCase();
        if (!people.some((p) => p.email !== me && p.name.toLowerCase() === first)) {
          setError(resolved.error);
          return;
        }
      } else {
        target = data.sessions[resolved.sessionId]!;
        body = resolved.rest;
        toAgent = true;
      }
    }
    setBusy(true);
    setError('');
    try {
      await sendMessage(threadId, body, target.depth === 0 ? undefined : target.id, undefined, images.files, { mentions, toAgent });
      setText('');
      images.clear();
      if (target.id !== session.id) go(target.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BlockStack gap="200" {...images.dropProps}>
      <TypingLine threadId={threadId} />
      <WaitingMessages data={data} session={session} />
      <SessionStatus session={session} />
      {session.depth === 0 && !dmQuiet ? <HeldLine threadId={threadId} data={data} session={session} label={label} /> : null}
      {error || images.error ? <StatusLine tone="critical" icon="alert">{error || images.error}</StatusLine> : null}
      <AttachmentTray files={images.files} onRemove={images.remove} />
      <div className="composer-anchor">
      {picker.list}
      <Composer
        ref={ref}
        onKeyDown={picker.onKeyDown}
        // On a phone Return adds a line and the send button sends, as in the ChatGPT and Claude apps.
        enterSends={!isPhoneTouch()}
        label={`Message ${label}`}
        value={text}
        onChange={(t) => {
          setText(t);
          if (me && t.trim()) sendTyping();
        }}
        onSubmit={() => void submit()}
        onPaste={images.onPaste}
        leading={images.button}
        disabled={!online}
        placeholder={
          session.depth > 0
            ? `Message ${label} directly, or @ an agent`
            : dmQuiet
              ? `Message, or @${label} to bring in an agent`
              : me && people.length > 1
                ? 'Reply, or @ an agent or a colleague'
                : 'Reply, or @ an agent'
        }
        trailing={
          <>
            <ChipSelect label="Talk to" value={session.id} options={options} onChange={go} />
            {working && !text.trim() && !images.files.length ? (
              <IconButton tone="primary" icon="stop" label={`Stop ${label}`} disabled={!online} onClick={() => void stopSession(session.id)} />
            ) : (
              <IconButton tone="primary" icon="arrowUp" label="Send" disabled={(!text.trim() && !images.files.length) || busy || !online} onClick={() => void submit()} />
            )}
          </>
        }
      />
      </div>
    </BlockStack>
  );
}

type Suggestion = { key: string; kind: 'agent' | 'person'; label: string; detail: string; role?: string; email?: string };

/**
 * "@" in the composer: a list of the agents in this thread and the colleagues on the
 * server. Arrows move, Enter or Tab picks, Escape closes. Picking writes "@Name ".
 */
function useMentionPicker(
  text: string,
  setText: (t: string) => void,
  ref: { current: HTMLTextAreaElement | null },
  options: SessionOption[],
  people: { email: string; name: string }[],
) {
  const [index, setIndex] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const caret = ref.current && document.activeElement === ref.current ? ref.current.selectionStart : text.length;
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(before);
  const query = match ? match[2]!.toLowerCase() : null;
  const suggestions: Suggestion[] =
    query === null || closedAt === before
      ? []
      : [
          ...options.map((o): Suggestion => ({ key: o.value, kind: 'agent', label: o.label, detail: 'agent', role: o.role })),
          ...people.map((p): Suggestion => ({ key: p.email, kind: 'person', label: p.name, detail: p.email, email: p.email })),
        ]
          .filter((s) => s.label.toLowerCase().startsWith(query) || s.email?.startsWith(query) || s.role?.startsWith(query))
          .slice(0, 7);
  const active = Math.min(index, Math.max(0, suggestions.length - 1));

  useEffect(() => setIndex(0), [query]);

  const pick = (s: Suggestion) => {
    if (!match) return;
    const start = match.index + match[1]!.length;
    const next = `${text.slice(0, start)}@${s.label} ${text.slice(caret)}`;
    setText(next);
    const at = start + s.label.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!suggestions.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((active + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
    } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(suggestions[active]!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setClosedAt(before);
    }
  };

  const agents = suggestions.filter((s) => s.kind === 'agent');
  const persons = suggestions.filter((s) => s.kind === 'person');
  const row = (s: Suggestion) => (
    <button
      key={s.key}
      type="button"
      role="option"
      aria-selected={s === suggestions[active]}
      className="mention-option"
      // Keep the focus in the text box.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pick(s)}
    >
      {s.kind === 'agent' ? <RoleFace role={s.role!} size="xs" decorative /> : <PersonFace email={s.email!} size={18} />}
      <span className="mention-option__label">{s.label}</span>
      <span className="mention-option__detail">{s.detail}</span>
    </button>
  );
  const list = suggestions.length ? (
    <div className="mention-list" role="listbox" aria-label="Tag an agent or a colleague">
      {agents.length ? <div className="mention-list__head">Agents</div> : null}
      {agents.map(row)}
      {persons.length ? <div className="mention-list__head">People</div> : null}
      {persons.map(row)}
    </div>
  ) : null;
  return { list, onKeyDown };
}

/** A colleague's face, with a green dot while they have this thread open. */
function LiveFace({ threadId, email, size }: { threadId: string; email: string; size: number }) {
  const me = useApp((s) => s.me);
  const live = useApp((s) => email !== me && Boolean(s.presence[threadId]?.viewing.includes(email)));
  const name = usePersonName(email);
  return (
    <span className={cx('live-face', live && 'live-face--on')}>
      <PersonFace email={email} size={size} title={live ? `${name} · looking at this now` : name} />
    </span>
  );
}

/** "Juliette is typing…" above the composer. */
function TypingLine({ threadId }: { threadId: string }) {
  const me = useApp((s) => s.me);
  const typing = useApp((s) => s.presence[threadId]?.typing);
  const people = useApp((s) => s.people);
  const others = (typing ?? []).filter((e) => e !== me);
  if (!others.length) return null;
  const names = others.map((e) => personName(e, people));
  return (
    <Text as="p" variant="caption" tone="secondary" className="typing-line" aria-live="polite">
      {names.length === 1 ? `${names[0]} is typing…` : `${names.join(' and ')} are typing…`}
    </Text>
  );
}

/** The agent holds off because people tagged each other: who it waits for, and Go ahead. */
function HeldLine({ threadId, data, session, label }: { threadId: string; data: ThreadData; session: Session; label: string }) {
  const people = useApp((s) => s.people);
  const online = useApp((s) => s.connection === 'online');
  const [busy, setBusy] = useState(false);
  const waiting = useMemo(() => {
    const done = new Set<number>();
    for (const e of data.events) if (e.type === 'message_delivery' && e.sessionId === session.id) done.add(e.messageId);
    const held = data.events.filter((e): e is Ev<'message'> => e.type === 'message' && e.sessionId === session.id && e.delivery === 'held' && !done.has(e.id));
    return [...new Set(held.flatMap((e) => e.mentions ?? []))];
  }, [data.events, session.id]);
  if (!waiting.length) return null;
  return (
    <InlineStack gap="150" blockAlign="center" className="session-status held-line">
      <Icon name="clock" size={13} />
      <Text as="span" variant="bodySm" tone="secondary" className="grow">
        {label} is waiting for {waiting.map((e) => personName(e, people)).join(', ')}
      </Text>
      <Button
        size="slim"
        variant="secondary"
        icon="play"
        disabled={busy || !online}
        onClick={() => {
          setBusy(true);
          void releaseThread(threadId).finally(() => setBusy(false));
        }}
      >
        Go ahead
      </Button>
    </InlineStack>
  );
}

/** "Thinking · 12s" under the last message while the agent works. */
function WorkingLine({ session, data }: { session: Session; data: ThreadData }) {
  const label = useRoleLabel(session.role);
  const startedAt = useMemo(() => {
    const t = [...data.events].reverse().find((e) => e.sessionId === session.id && e.type === 'turn_started');
    return t?.ts ?? session.updatedAt;
  }, [data.events, session.id, session.updatedAt]);
  if (session.status !== 'running' && session.status !== 'queued') return null;
  return (
    <InlineStack gap="150" className="working-line">
      <Shimmer>{session.status === 'queued' ? `${label} is queued` : 'Thinking'}</Shimmer>
      <Text as="span" variant="bodyLg" tone="tertiary">
        <Elapsed since={startedAt} />
      </Text>
    </InlineStack>
  );
}

function SessionStatus({ session }: { session: Session }) {
  const label = useRoleLabel(session.role);
  if (session.status === 'interrupted' || session.status === 'error') {
    return (
      <InlineStack gap="150" className={`session-status session-status--${session.status}`}>
        <Icon name="alert" size={13} />
        <Text as="span" variant="bodySm" tone={session.status === 'error' ? 'critical' : 'caution'}>
          {session.status === 'interrupted' ? `${label} was interrupted by a restart.` : `${label}’s last turn failed.`}
        </Text>
        <Button size="slim" variant="secondary" icon="play" onClick={() => void resumeSession(session.id)}>
          {session.status === 'interrupted' ? 'Resume' : 'Retry'}
        </Button>
      </InlineStack>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------

export function ThreadView({ threadId, sessionId }: { threadId: string; sessionId?: string }) {
  const thread = useApp((s) => s.threads[threadId] ?? s.details[threadId]?.thread);
  const loadError = useApp((s) => s.loadErrors[threadId]);
  const data = useApp((s) => s.details[threadId]);
  const previewOpen = useApp((s) => s.previewOpen);
  const showSpend = useApp((s) => s.showSpend);
  const docs = usePreviewDocs(threadId, true);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const now = useNow(30_000);
  const labels = useRoleLabels();
  const me = useApp((s) => s.me);
  const starter = usePersonName(me && thread?.createdBy && thread.createdBy !== me ? thread.createdBy : null);
  const people = useApp((s) => s.people);
  const updatedAt = thread?.updatedAt;
  // Looking at a DM reads it, including what arrives while it is open.
  useEffect(() => {
    if (thread?.dm) markDmSeen(threadId);
  }, [thread?.dm, threadId, updatedAt]);

  const rootId = thread?.rootSessionId ?? '';
  const session = data?.sessions[sessionId ?? rootId];
  const items = useMemo(() => (data && session ? buildItems(data.events, session, labels) : []), [data, session, labels]);
  const parent = session?.parentSessionId ? data?.sessions[session.parentSessionId] : undefined;

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length, data?.events.length]);
  useEffect(() => {
    stick.current = true;
  }, [sessionId]);

  if (!thread || !data || !session) {
    const missing = loadError || (data && !session);
    return (
      <Panel as="main" className="pane-main pane-main--chat">
        <PanelHeader size="lg" />
        <div className="pane-center">
          {missing ? (
            <BlockStack gap="300" align="center">
              <Text as="p" tone="secondary">
                {loadError ? `This thread could not be opened: ${loadError}` : 'That agent is not part of this thread.'}
              </Text>
              <Button variant="secondary" onClick={() => navigate(loadError ? { name: 'threads' } : { name: 'thread', threadId })}>
                {loadError ? 'Back to Threads' : 'Open the thread'}
              </Button>
            </BlockStack>
          ) : (
            <Shimmer>Loading</Shimmer>
          )}
        </div>
      </Panel>
    );
  }

  const label = labels[session.role] ?? session.role;
  const showPreview = previewOpen && docs.length > 0;
  const lastIndex = items.length - 1;
  const sessionRunning = session.status === 'running';

  return (
    <>
      <Panel as="main" className="pane-main pane-main--chat">
        <PanelHeader size="lg">
          {session.depth > 0 ? (
            <InlineStack gap="200" className="thread-title">
              <IconButton
                icon="chevronLeft"
                label={`Back to ${labels[parent?.role ?? ''] ?? 'the thread'}`}
                onClick={() => navigate({ name: 'thread', threadId, sessionId: !parent || parent.depth === 0 ? undefined : parent.id })}
              />
              <RoleFace role={session.role} size="md" />
              <BlockStack className="thread-title__text">
                <Text variant="headingMd" as="span" leading="tight" truncate>
                  {label}
                </Text>
                <Text variant="caption" tone="secondary" leading="tight" truncate>
                  Stepped in · {engineName(session.engine)} · {session.model} · {thread.title}
                </Text>
              </BlockStack>
            </InlineStack>
          ) : thread.dm ? (
            <InlineStack gap="200" blockAlign="center" className="thread-title">
              {(thread.people ?? [])
                .filter((p) => p !== me)
                .slice(0, 3)
                .map((p) => (
                  <LiveFace key={p} threadId={threadId} email={p} size={24} />
                ))}
              <BlockStack className="thread-title__text">
                <Text variant="headingMd" as="h1" leading="tight" truncate>
                  {dmTitle(thread, me, people)}
                </Text>
                <Text variant="caption" tone="secondary" leading="tight" truncate>
                  Direct message · @ an agent to bring one in
                </Text>
              </BlockStack>
              <span className="dm-private">🔒 Only {(thread.people?.length ?? 2) > 2 ? 'you' : 'you two'}</span>
            </InlineStack>
          ) : (
            <BlockStack className="thread-title thread-title__text">
              <Text variant="headingMd" as="h1" leading="tight" truncate title={thread.title}>
                {thread.title}
              </Text>
              <Text variant="caption" tone="secondary" leading="tight" truncate>
                {starter ? `Started by ${starter} · ` : ''}
                {thread.roles.map((r) => labels[r] ?? r).join(', ')}
                {thread.benched?.length ? ` · without ${thread.benched.map((r) => labels[r] ?? r).join(', ')}` : ''} · started {ago(thread.createdAt, now)}
                {showSpend && usageLabel(thread.usage) ? (
                  <span className="numeric" title={usageTitle(thread.usage)}>
                    {' · '}
                    {usageLabel(thread.usage)} spent
                  </span>
                ) : null}
              </Text>
            </BlockStack>
          )}
          <span className="cr-spacer" />
          <span className="header-faces phone-hide">
            {me && !thread.dm && (thread.people?.length ?? 0) > 1 ? (
              <span className="list-trailing" aria-label="People in this thread">
                {thread.people!.map((p) => (
                  <LiveFace key={p} threadId={threadId} email={p} size={20} />
                ))}
              </span>
            ) : null}
            <RoleFaces roles={thread.roles} size="md" />
          </span>
          {session.depth === 0 && !thread.dm && (
            <Button size="slim" icon="reload" className="phone-hide" title="Ask the same question in a new thread, with specialists switched on or off" onClick={() => runAgain(threadId)}>
              Run again
            </Button>
          )}
          {session.depth === 0 && !thread.dm && <ShareButton threadId={threadId} />}
          <Button size="slim" icon="checkCircle" className="header-close phone-hide" onClick={() => void archiveThread(threadId)}>
            Close thread
          </Button>
          <IconButton icon="checkCircle" label="Close thread" className="phone-only" onClick={() => void archiveThread(threadId)} />
          {docs.length > 0 && !showPreview ? <IconButton icon="sidebar" label="Show preview" onClick={() => togglePreview(true)} /> : null}
        </PanelHeader>

        <div
          className="pane-scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="chat">
            {items.length === 0 ? (
              <Text tone="secondary">{session.depth > 0 ? `Nothing from ${label} yet.` : 'Nothing here yet.'}</Text>
            ) : (
              items.map((item, i) =>
                item.kind === 'work' ? (
                  <WorkGroup key={item.id} events={item.events} data={data} sessionRunning={sessionRunning} isLast={i === lastIndex} />
                ) : item.kind === 'subagents' ? (
                  <SubagentGroup key={item.id} threadId={threadId} starts={item.starts} data={data} />
                ) : (
                  <EventRow key={item.event.id} threadId={threadId} event={item.event} session={session} answer={item.answer} />
                ),
              )
            )}
            <WorkingLine session={session} data={data} />
          </div>
        </div>

        <div className="composer-dock">
          <OtherApprovals threadId={threadId} session={session} rootId={rootId} />
          {/* Keyed by session: a draft never follows you to another agent. */}
          <ThreadComposer key={session.id} threadId={threadId} session={session} data={data} rootId={rootId} />
        </div>
      </Panel>
      {showPreview && (
        <PaneResizer target="after" label="Resize preview" min={320} minOther={380} onResize={setPreviewWidth} onReset={() => setPreviewWidth(null)} />
      )}
      {showPreview && <PreviewPanel threadId={threadId} docs={docs} />}
    </>
  );
}
