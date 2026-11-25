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
      /** Owner message: the Inbox question (needs_you inboxId) it answers. */
      replyTo?: string;
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
  /** ask_owner: one question, optionally with answers the owner can click. */
  | { type: 'needs_you'; question: string; inboxId: string; options?: QuestionOption[]; recommended?: number; multiSelect?: boolean }
  /** A tool call waits for the owner (approve or deny in the Inbox). */
  | { type: 'approval'; inboxId: string; toolName: string; input: unknown }
  | { type: 'approval_done'; inboxId: string; toolName: string; approved: boolean }
  | { type: 'preview'; previewId: string; title: string; format: DocFormat; content: string; /** The doc behind it (Docs tab). Missing on previews from older builds. */ artifactId?: string }
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

/** A clickable answer to an ask_owner question. */
export interface QuestionOption {
  /** What the button says, and what is sent back as the answer. */
  label: string;
  /** One line under the label: a cost, a consequence. */
  detail?: string;
}

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
  /** needs_you: the answers the owner can click, and the asker's best guess (index). */
  options?: QuestionOption[];
  recommended?: number;
  /** The owner may pick more than one option. */
  multiSelect?: boolean;
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
  team: { name: string; suggestions: string[]; fonts?: BrandFont[] };
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
  | { kind: 'inbox'; item: InboxItem }
  | { kind: 'doc'; doc: DocSummary };

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

/** A sign-in running on a server, started from the app (admins only). */
export interface ServerLogin {
  id: string;
  connection: string;
  label: string;
  /** The page to open in the browser. */
  url?: string;
  /** A one-time code to enter on that page (device sign-in). */
  code?: string;
  /** The CLI waits for a code the person copies from the page. */
  needsInput: boolean;
  /** The page sends the browser back to 127.0.0.1 on this port; the app passes it on. */
  callbackPort?: number;
  /** The last lines the CLI printed, for when something goes wrong. */
  output?: string;
  done: boolean;
  ok?: boolean;
}

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

// ---------------------------------------------------------------------------
// Documents

/** Where a doc stands. Agents make drafts; the owner approves the version that counts. */
export type DocStatus = 'draft' | 'approved';

/** A doc the owner has been shown (the Docs tab): an artifact plus where it stands. */
export interface DocSummary {
  id: string;
  threadId: string;
  threadTitle: string;
  /** The agent that made it. */
  agent: string;
  title: string;
  format: DocFormat;
  status: DocStatus;
  createdAt: number;
  /** When it was last put in the preview. */
  shownAt: number;
  approvedAt: number | null;
}

export interface DocResponse extends DocSummary {
  content: string;
}

/**
 * How an artifact or preview is written. `concepts` is a ConceptBoard as JSON:
 * the app draws it as ad mockups in the team's brand fonts.
 */
export type DocFormat = 'markdown' | 'html' | 'concepts';

/** A team font (crew.config.ts `fonts`). The app loads it from /api/brand-fonts/<role>. */
export interface BrandFont {
  /** text: everything by default. accent: the words a headline marks with *asterisks*. */
  role: 'text' | 'accent';
  family: string;
  weight?: number;
  style?: 'normal' | 'italic';
}

/** Ad concepts for review: a round of static ads, each drawn as image + headline. */
export interface ConceptBoard {
  /** One or two sentences above the board: what this round is. */
  intro?: string;
  /** Ad shape. Default 4:5 (Meta feed). */
  aspect?: '4:5' | '1:1' | '9:16';
  concepts: Concept[];
}

export interface Concept {
  name: string;
  /** The idea in one sentence. */
  angle: string;
  /** What it tells people about the brand. */
  tells?: string;
  /** Why people stop scrolling. */
  stop?: string;
  /** Why people click. */
  click?: string;
  audience?: string;
  image: {
    /** What the image shows; drawn as a placeholder until there is a picture. */
    description: string;
    /** A picture in the thread: attachments/<file> or just <file>. */
    file?: string;
    /** Background colour behind the placeholder, e.g. #8ec9ee. */
    background?: string;
    /** Headline colour on the ad. Default: black or white, whichever reads on the background. */
    textColor?: string;
    /** Where the headline sits. Default top. */
    textPosition?: 'top' | 'center' | 'bottom';
  };
  /** Options for the line on the ad. Words in *asterisks* are set in the accent font. */
  headlines: Array<{ text: string; star?: boolean }>;
  primaryText?: string;
  linkHeadline?: string;
  /** Anything the owner must check, e.g. a claim that needs approval. */
  notes?: string;
}

const COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;

/**
 * Reads a ConceptBoard from JSON. Throws an error that says what to fix,
 * written for the agent that made it.
 */
export function parseConceptBoard(json: string): ConceptBoard {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`A concepts document must be JSON: ${(e as Error).message}`);
  }
  const fail = (msg: string): never => {
    throw new Error(`Concept board: ${msg}`);
  };
  const obj = (v: unknown, where: string): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(`${where} must be an object`);
  const str = (v: unknown, where: string, required = false): string | undefined => {
    if (v === undefined || v === null || v === '') return required ? fail(`${where} is required`) : undefined;
    return typeof v === 'string' ? v : fail(`${where} must be text`);
  };
  const color = (v: unknown, where: string): string | undefined => {
    const c = str(v, where);
    return c === undefined || COLOR.test(c.trim()) ? c?.trim() : fail(`${where} must be a CSS colour like #8ec9ee`);
  };

  const b = obj(raw, 'The document');
  const aspect = b.aspect ?? '4:5';
  if (aspect !== '4:5' && aspect !== '1:1' && aspect !== '9:16') fail('aspect must be 4:5, 1:1 or 9:16');
  if (!Array.isArray(b.concepts) || b.concepts.length === 0) fail('concepts must be a list with at least one concept');
  const concepts = (b.concepts as unknown[]).map((v, i): Concept => {
    const at = `concepts[${i}]`;
    const c = obj(v, at);
    const img = obj(c.image, `${at}.image`);
    const pos = img.textPosition ?? 'top';
    if (pos !== 'top' && pos !== 'center' && pos !== 'bottom') fail(`${at}.image.textPosition must be top, center or bottom`);
    if (!Array.isArray(c.headlines) || c.headlines.length === 0) fail(`${at}.headlines must list at least one headline`);
    return {
      // The board numbers concepts itself: "3. Between…" would read "3. 3. Between…".
      name: str(c.name, `${at}.name`, true)!.replace(/^\s*\d+\s*[.):-]\s*/, ''),
      angle: str(c.angle, `${at}.angle`, true)!,
      tells: str(c.tells, `${at}.tells`),
      stop: str(c.stop, `${at}.stop`),
      click: str(c.click, `${at}.click`),
      audience: str(c.audience, `${at}.audience`),
      image: {
        description: str(img.description, `${at}.image.description`, true)!,
        file: str(img.file, `${at}.image.file`)?.replace(/^attachments\//, ''),
        background: color(img.background, `${at}.image.background`),
        textColor: color(img.textColor, `${at}.image.textColor`),
        textPosition: pos as 'top' | 'center' | 'bottom',
      },
      headlines: (c.headlines as unknown[]).map((h, j) => {
        if (typeof h === 'string') return { text: h };
        const o = obj(h, `${at}.headlines[${j}]`);
        return { text: str(o.text, `${at}.headlines[${j}].text`, true)!, star: o.star === true };
      }),
      primaryText: str(c.primaryText, `${at}.primaryText`),
      linkHeadline: str(c.linkHeadline, `${at}.linkHeadline`),
      notes: str(c.notes, `${at}.notes`),
    };
  });
  return { intro: str(b.intro, 'intro'), aspect: aspect as ConceptBoard['aspect'], concepts };
}
