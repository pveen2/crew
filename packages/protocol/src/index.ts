// Shared types between the conductor (apps/conductor) and its clients
// (the Mac app, the crew CLI and the try script). Keep this file free of
// runtime dependencies so it can be imported anywhere.

export type Engine = 'claude-code' | 'codex' | 'grok' | 'antigravity';
export type Permissions = 'read-only' | 'draft';

export type ThreadStatus = 'idle' | 'running' | 'needs_you' | 'interrupted' | 'error';
export type SessionStatus = 'idle' | 'running' | 'queued' | 'interrupted' | 'error';
export type TurnStatus = 'running' | 'done' | 'interrupted' | 'error' | 'cancelled';

export interface Thread {
  id: string;
  title: string;
  status: ThreadStatus;
  /** The session that owns the thread (the GM by default). */
  rootSessionId: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** Roles with a session in this thread, owner first. */
  roles: string[];
  /** One line for the sidebar: what is happening now ("Needs you", "Store manager: using shopify_query", …). */
  statusText: string;
  /** Specialists switched off for this thread: the lead cannot call them. */
  benched: string[];
  /** What every turn in the thread used so far, all agents together. */
  usage: Usage;
}

/**
 * What a turn used. Engines run on the owner's subscriptions, so costUsd is what
 * the same work would cost at API prices, as the engine reports it (Claude Code
 * does; Codex reports only tokens). Null: no turn reported a cost.
 */
export interface Usage {
  costUsd: number | null;
  /** All input tokens, cached ones included. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Thread totals only: tokens from turns that reported no cost (Codex, for one).
   * When this is above 0 and costUsd is set, costUsd covers only part of the work.
   */
  unpricedTokens?: number;
}

export interface Session {
  id: string;
  threadId: string;
  role: string;
  engine: Engine;
  model: string;
  status: SessionStatus;
  /** Session id inside Claude Code or Codex, used to resume. */
  engineSessionId: string | null;
  parentSessionId: string | null;
  /** 0 = thread owner (the lead), 1 = a specialist the lead called. */
  depth: number;
  workdir: string;
  createdAt: number;
  updatedAt: number;
}

export interface Turn {
  id: string;
  sessionId: string;
  threadId: string;
  prompt: string;
  status: TurnStatus;
  /** Set when the lead started this turn by calling this specialist. */
  callerSessionId: string | null;
  result: string | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Null while running, or when the engine reported nothing. */
  usage: Usage | null;
}

// ---------------------------------------------------------------------------
// Events. Everything that happens in a thread is an event. The app renders
// the thread purely from its events.

export interface EventBase {
  id: number;
  threadId: string;
  sessionId: string;
  turnId: string | null;
  ts: number;
}

/** An image the owner attached to a message. Stored per thread by the conductor. */
export interface Attachment {
  /** File name inside the thread's attachments folder (and agents' attachments/ folder). */
  file: string;
  /** Original name, for display. */
  name: string;
  mime: string;
  size: number;
}

/** An image as the app uploads it. */
export interface AttachmentUpload {
  name: string;
  mime: string;
  /** Base64, without a data: prefix. */
  data: string;
}

export type CrewEventBody =
  | {
      type: 'message';
      role: 'user' | 'assistant';
      text: string;
      from?: string;
      attachments?: Attachment[];
      /**
       * An owner message sent while the agent was working. 'steer': written into
       * the running turn (event turnId), read at the agent's next step. 'queue':
       * waits for the turn with this event's turnId to start.
       */
      delivery?: 'steer' | 'queue';
    }
  /**
   * What became of an owner message sent while the agent worked: read (steered
   * and read), requeued (missed the turn, waits for nextTurnId), edited (new
   * text, before the agent had it) or removed (taken back by the owner).
   */
  | { type: 'message_delivery'; messageId: number; state: 'read' | 'requeued' | 'edited' | 'removed'; nextTurnId?: string; text?: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; callId: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; output: string; isError: boolean }
  | {
      type: 'subagent_started';
      childSessionId: string;
      childTurnId: string;
      role: string;
      engine: Engine;
      model: string;
      brief: string;
    }
  | {
      type: 'subagent_done';
      childSessionId: string;
      childTurnId: string;
      role: string;
      status: TurnStatus;
      result: string;
      durationMs: number;
    }
  | { type: 'needs_you'; question: string; inboxId: string }
  /** A tool call waits for the owner (approve or deny in the Inbox). */
  | { type: 'approval'; inboxId: string; toolName: string; input: unknown }
  | { type: 'approval_done'; inboxId: string; toolName: string; approved: boolean }
  | { type: 'preview'; previewId: string; title: string; format: 'markdown' | 'html'; content: string }
  | {
      type: 'turn_started';
      prompt: string;
      resumed: boolean;
      /** Set when the lead started this turn by calling this specialist. */
      callerRole?: string;
    }
  | { type: 'turn_done'; status: TurnStatus; durationMs: number; error?: string; usage?: Usage }
  | { type: 'status'; text: string };

export type CrewEvent = EventBase & CrewEventBody;
export type CrewEventType = CrewEventBody['type'];

// ---------------------------------------------------------------------------
// Inbox: things that need the owner.

export type InboxKind = 'needs_you' | 'approval' | 'interrupted' | 'error' | 'draft';

export interface InboxItem {
  id: string;
  threadId: string;
  sessionId: string;
  kind: InboxKind;
  /** Role of the agent the item is about. */
  role: string;
  /** For drafts: the preview event's previewId. */
  previewId?: string;
  title: string;
  body: string;
  status: 'open' | 'resolved';
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Team overview.

export interface RoleSummary {
  name: string;
  label: string;
  description: string;
  engine: Engine;
  model: string;
  permissions: Permissions;
  /** The lead (agent/agent.ts). Every other agent is a specialist it can call. */
  isLead: boolean;
}

export interface AgentActivity {
  role: string;
  sessionId: string;
  threadId: string;
  threadTitle: string;
  status: SessionStatus;
  doing: string;
  since: number;
}

// ---------------------------------------------------------------------------
// HTTP API

export interface StateResponse {
  /** The team this conductor runs (crew.config.ts). */
  team: { name: string; suggestions: string[] };
  /** Open threads. */
  threads: Thread[];
  /** Closed (archived) threads, most recent first. */
  done: Thread[];
  inbox: InboxItem[];
  roles: RoleSummary[];
  activity: AgentActivity[];
}

export interface ThreadDetailResponse {
  thread: Thread;
  sessions: Session[];
  turns: Turn[];
  events: CrewEvent[];
}

export interface CreateThreadRequest {
  text: string;
  /** Images (png, jpeg, gif, webp). */
  attachments?: AttachmentUpload[];
  /** Agent that owns the thread. Defaults to the lead (agent/agent.ts). */
  role?: string;
  /** Specialists to switch off for this thread (agent names). */
  benched?: string[];
}

export interface SendMessageRequest {
  text: string;
  attachments?: AttachmentUpload[];
  /** Send to a specific session ("Step in"). Defaults to the thread owner. */
  sessionId?: string;
  /** The Inbox question this message answers. Only that item is resolved. */
  replyTo?: string;
}

// ---------------------------------------------------------------------------
// WebSocket messages from the conductor to clients.

export type ServerMessage =
  | { kind: 'hello'; version: 1 }
  | { kind: 'event'; event: CrewEvent }
  | { kind: 'thread'; thread: Thread }
  | { kind: 'session'; session: Session }
  | { kind: 'turn'; turn: Turn }
  | { kind: 'inbox'; item: InboxItem };

// ---------------------------------------------------------------------------
// Where the conductor advertises itself on this machine.

export interface ConductorInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export const DEFAULT_PORT = 4317;

/** An outside tool Crew depends on: an engine CLI or a service the agents reach. */
export type ConnectionId = 'claude' | 'codex' | 'grok' | 'antigravity' | 'shopify' | 'browser';

export interface ConnectionStatus {
  id: ConnectionId;
  label: string;
  /**
   * connected: signed in and working. signed_out: installed, not signed in.
   * missing: the CLI is not installed. unknown: the check failed or timed out.
   */
  status: 'connected' | 'signed_out' | 'missing' | 'unknown';
  /** Account, store or reason, for the tooltip. */
  detail?: string;
  /** Agents that rely on it. Empty: the team does not use it right now. */
  usedBy: string[];
  /** The app can open a sign-in for it. */
  canSignIn: boolean;
  /** The conductor runs on a server: sign-ins happen there, not from the app. */
  onServer?: boolean;
  checkedAt: number;
}
