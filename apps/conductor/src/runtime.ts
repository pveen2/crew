// The heart of the conductor. Threads own a root session (the lead, agent/);
// sessions run turns on their engine; the lead's subagent tools start or
// reuse a specialist's session in the same thread and wait for its answer.
// Specialists do not delegate further (one level, like eve).

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type {
  AgentActivity,
  Attachment,
  AttachmentUpload,
  CrewEvent,
  CrewEventBody,
  DocFormat,
  DocResponse,
  DocStatus,
  DocSummary,
  Engine,
  InboxItem,
  InboxKind,
  QuestionOption,
  RoleSummary,
  ServerMessage,
  StateResponse,
  Thread,
  ThreadDetailResponse,
  ThreadStatus,
  TurnStatus,
  Usage,
} from '@crew/protocol';
import { parseConceptBoard } from '@crew/protocol';
import { parseModel } from '@crew/sdk/define';
import { loadCrew, subagentToolName, type LoadedAgent, type LoadedCrew } from '@crew/sdk/load';
import { REAL_HOME, denyPaths, nodeChildEnv, paths, port, steeringEnabled } from './config.ts';
import type { ArtifactRow, SessionRow, Store } from './db.ts';
import { addUsage, engines, type EngineEvent, type McpServerSpec, type Steer } from './engines/index.ts';
import { translateAgent, type MemoryRecall } from './translate.ts';
import { REVIEW_PROMPT, branchDiff, codeSettings, ensureCheckout, mergePullRequest, openPullRequest, snapshot, themePreview } from './code.ts';

type AbortReason = 'stop' | 'timeout' | 'shutdown';

interface RunningTurn {
  turnId: string;
  controller: AbortController;
  done: Promise<TurnOutcome>;
  /** Set while the engine can take an owner message into this turn. */
  steer: Steer | null;
}

export interface TurnOutcome {
  turnId: string;
  status: TurnStatus;
  text: string;
  error?: string;
}

interface TurnOptions {
  turnId?: string;
  callerSessionId?: string | null;
  resumed?: boolean;
  /** Abort the turn when this signal fires (the caller went away). */
  signal?: AbortSignal;
  /** The owner answered this specialist's question: pass its reply on to the colleague who asked it for work. */
  notifyParent?: boolean;
  /** Attachment files (names in the thread's attachments folder) sent with this turn's message. */
  images?: string[];
  /** The queued owner message this turn delivers: it can still be edited or removed until the turn starts. */
  queuedMessage?: QueuedMessage;
  /** Skip without a "dropped" line in the thread (the owner took the message back). */
  quiet?: boolean;
}

/** An owner message waiting for the agent's current turn to end. */
interface QueuedMessage {
  eventId: number;
  sessionId: string;
  /** Builds the agent's prompt from the (possibly edited) text. */
  prompt: (text: string) => string;
  text: string;
  removed: boolean;
  /** The question this message answers: reopened when the message is taken back. */
  replyTo?: string;
}

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** What the app may fetch from a thread's folder: images, and videos kept from a page (agent_browser_keep_media). */
const ATTACHMENT_TYPES: Record<string, string> = { ...IMAGE_TYPES, 'video/mp4': 'mp4', 'video/webm': 'webm' };
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Store uploaded images in the thread's attachments folder. */
function saveAttachments(threadId: string, uploads: AttachmentUpload[] | undefined): Attachment[] {
  if (!uploads?.length) return [];
  if (uploads.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message.`);
  const dir = join(paths.attachments, threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return uploads.map((u) => {
    const ext = IMAGE_TYPES[u.mime];
    if (!ext) throw new Error(`${u.name}: only PNG, JPEG, GIF and WebP images can be attached.`);
    const data = Buffer.from(u.data, 'base64');
    if (!data.length) throw new Error(`${u.name} is empty.`);
    if (data.length > MAX_IMAGE_BYTES) throw new Error(`${u.name} is larger than 10 MB.`);
    const base = u.name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
    const file = `${randomBytes(3).toString('hex')}-${base}.${ext}`;
    writeFileSync(join(dir, file), data, { mode: 0o600 });
    return { file, name: u.name || file, mime: u.mime, size: data.length };
  });
}

/** What the agent reads about the images that came with a message. */
function attachmentNote(atts: Attachment[]): string {
  if (!atts.length) return '';
  return (
    `\n\n[The owner attached ${atts.length === 1 ? 'an image' : `${atts.length} images`}: ` +
    atts.map((a) => `attachments/${a.file}`).join(', ') +
    '. They are in your attachments/ folder; look at them before you answer. ' +
    'To let a specialist see one, name the file in the brief: they have the same attachments/ folder.]'
  );
}

/** Copy the thread's images into an agent's working folder (read-only). */
function syncAttachments(threadId: string, workdir: string): void {
  const src = join(paths.attachments, threadId);
  if (!existsSync(src)) return;
  const dest = join(workdir, 'attachments');
  // The folder is the conductor's: anything else in its place (a link an agent made) is replaced.
  const found = lstatSync(dest, { throwIfNoEntry: false });
  if (found && !found.isDirectory()) rmSync(dest, { force: true });
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(src)) {
    // Dot files are images still being written (guard.ts).
    if (f.startsWith('.')) continue;
    const to = join(dest, f);
    if (lstatSync(to, { throwIfNoEntry: false })) continue;
    copyFileSync(join(src, f), to);
    chmodSync(to, 0o444);
  }
}

const NOT_STARTED = 'Not started: Crew stopped first';

/**
 * Stop a CLI left running by a conductor that crashed, with the MCP servers it
 * started. Only if its command line still names this Crew session (its run
 * folder or bridge env): after a reboot the pid may belong to something else.
 */
function killOrphan(pid: number | null, sessionId: string): void {
  if (!pid) return;
  try {
    const cmd = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (!cmd.includes(sessionId)) return;
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Not running any more.
  }
}

const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString('base64url')}`;

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0]!.replace(/\s+/g, ' ');
  return line.length > 64 ? line.slice(0, 61).trimEnd() + '…' : line || 'New thread';
}

/** Cleans a title a model wrote: one line, no quotes or trailing period, at most 64 characters. */
export function cleanTitle(raw: string): string {
  let t = raw.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  t = t.replace(/^(title|thread title)\s*:\s*/i, '').replace(/^[#*\s]+|[*\s]+$/g, '');
  t = t.replace(/^["'“‘`]+|["'”’`]+$/g, '').replace(/\.$/, '').replace(/\s+/g, ' ').trim();
  return t.length > 64 ? t.slice(0, 61).trimEnd() + '…' : t;
}

/**
 * The cheapest model per engine for the one-line thread title. Undefined: use the
 * lead's own model, which is also the fallback when the small one is not available.
 */
const TITLE_MODELS: Partial<Record<Engine, string>> = { 'claude-code': 'haiku', codex: 'gpt-6-luna' };

const TITLE_PROMPT = (text: string) =>
  'Write a short title (3 to 6 words) for a work thread that starts with the message below. ' +
  'Name the subject, not the request: "Rhode competitor research", not "Please research Rhode". ' +
  'Keep names and products as written. Same language as the message. ' +
  'Reply with the title only: no quotes, no period, no explanation. Do not use any tools.\n\n' +
  `<message>\n${text.slice(0, 4000)}\n</message>`;

/**
 * ask_owner's clickable answers, cleaned: 2–4 options with a label, and a
 * recommended index only when it points at one. Anything else: no buttons, the
 * owner types the answer, so a malformed list never blocks the question.
 */
export function questionOptions(args: Record<string, unknown>): { options?: QuestionOption[]; recommended?: number; multiSelect?: boolean } {
  if (!Array.isArray(args.options)) return {};
  const options: QuestionOption[] = [];
  let recommended: number | undefined;
  const seen = new Set<string>();
  args.options.forEach((o: unknown, index: number) => {
    const raw = typeof o === 'string' ? { label: o } : (o as Record<string, unknown> | null);
    const label = typeof raw?.label === 'string' ? raw.label.replace(/\s+/g, ' ').trim() : '';
    if (!label || /^(something else|other|anders|iets anders)\.?$/i.test(label)) return; // the text box covers it
    // The label is what gets sent back, so two equal labels would be the same answer.
    if (seen.has(label.toLowerCase()) || options.length === 4) return;
    seen.add(label.toLowerCase());
    // recommended points into the list the agent wrote: follow its option, not its position.
    if (index === args.recommended) recommended = options.length;
    const detail = typeof raw?.detail === 'string' ? raw.detail.replace(/\s+/g, ' ').trim() : '';
    options.push(detail ? { label, detail } : { label });
  });
  if (options.length < 2) return {};
  return { options, recommended, ...(args.multiSelect === true ? { multiSelect: true } : {}) };
}

/**
 * Why an ask_owner question would show badly as a card, or null. Agents tend
 * to write choices into the text ("(A) … (B) …") and tack on a second
 * question, which leaves the owner a wall of bold text and no buttons. The
 * error goes back to the agent, which asks again properly.
 */
export function questionProblem(question: string, hasOptions: boolean): string | null {
  const inlineChoices = /(^|\s)\(?[A-D1-4][).:]\s/m;
  const listed = (question.match(/(^|\s)\(?[A-D1-4][).:]\s/gm) ?? []).length;
  if (!hasOptions && inlineChoices.test(question) && listed >= 2)
    return 'Put the choices in options (2–4, each a short label plus an optional one-line detail), not in the question text. Ask again with just the question.';
  if ((question.match(/\?/g) ?? []).length > 1)
    return 'Ask one question per call. Ask the most important one now and the next after the owner answers.';
  if (question.length > 240)
    return 'Keep the question to one short sentence (under 240 characters). Move prices, consequences and context into the options\' detail lines.';
  return null;
}

function snippet(text: string, max = 120): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export class Runtime {
  private readonly running = new Map<string, RunningTurn>();
  /** Background title runs, by thread. */
  private readonly titleJobs = new Map<string, AbortController>();
  /** Owner messages still waiting for their turn, by message event id. */
  private readonly queuedMessages = new Map<number, QueuedMessage>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Turns waiting to start, per session. */
  private readonly pending = new Map<string, number>();
  /** Bumped by Stop; queued turns from an older generation are skipped. */
  private readonly stopGen = new Map<string, number>();
  private readonly bridgeSecret = randomBytes(32);
  /** Tool calls waiting for the owner's approve or deny, by Inbox item id. */
  /**
   * Approvals waiting on the owner, by inbox id: how to wake the call, and the
   * thread and `agent:tool` it asks for (so "Always allow" can clear the rest).
   * An entry is removed the moment it is settled.
   */
  private readonly approvals = new Map<string, { settle: (approved: boolean) => void; threadId: string; key: string }>();
  private listeners = new Set<(msg: ServerMessage) => void>();
  private shuttingDown = false;

  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  // -------------------------------------------------------------------------
  // Plumbing

  subscribe(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(msg: ServerMessage): void {
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch (err) {
        console.warn('[runtime] listener failed', err);
      }
    }
  }

  private emit(session: SessionRow, turnId: string | null, body: CrewEventBody): CrewEvent {
    const event = this.store.insertEvent({ ...body, threadId: session.threadId, sessionId: session.id, turnId, ts: Date.now() });
    this.broadcast({ kind: 'event', event });
    return event;
  }

  private setSession(id: string, patch: Parameters<Store['updateSession']>[1]): SessionRow {
    const s = this.store.updateSession(id, patch);
    this.broadcast({ kind: 'session', session: s });
    return s;
  }

  bridgeToken(sessionId: string): string {
    return createHmac('sha256', this.bridgeSecret).update(sessionId).digest('base64url');
  }

  checkBridgeToken(sessionId: string, token: string): boolean {
    const a = Buffer.from(this.bridgeToken(sessionId));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private refreshThread(threadId: string): void {
    const thread = this.store.thread(threadId);
    if (!thread) return;
    const sessions = this.store.sessionsOfThread(threadId);
    const root = sessions.find((s) => s.id === thread.rootSessionId);
    let status: ThreadStatus = 'idle';
    if (this.store.openInboxOfThread(threadId, ['needs_you', 'approval']).length) status = 'needs_you';
    else if (sessions.some((s) => s.status === 'running' || s.status === 'queued')) status = 'running';
    else if (root?.status === 'interrupted') status = 'interrupted';
    else if (root?.status === 'error') status = 'error';
    const next = this.store.updateThread(threadId, { status });
    this.broadcast({ kind: 'thread', thread: this.withMeta(next) });
  }

  private addInbox(
    session: SessionRow,
    kind: InboxKind,
    title: string,
    body: string,
    extra: Pick<InboxItem, 'previewId' | 'options' | 'recommended' | 'multiSelect' | 'url'> = {},
  ): InboxItem {
    const item: InboxItem = {
      id: newId('i'),
      threadId: session.threadId,
      sessionId: session.id,
      kind,
      role: session.role,
      ...extra,
      title,
      body,
      status: 'open',
      createdAt: Date.now(),
    };
    this.store.insertInbox(item);
    this.broadcast({ kind: 'inbox', item });
    return item;
  }

  resolveInbox(id: string): InboxItem | undefined {
    // Dismissing an approval without deciding counts as a deny.
    this.approvals.get(id)?.settle(false);
    const item = this.store.resolveInbox(id);
    if (item) {
      this.broadcast({ kind: 'inbox', item });
      this.refreshThread(item.threadId);
    }
    return item;
  }

  /** The owner merges a Developer's pull request from the Inbox. The item leaves the Inbox and the thread says so. */
  async mergePullRequest(id: string): Promise<InboxItem> {
    const item = this.store.inboxItem(id);
    if (!item) throw new Error('No such item');
    if (item.kind !== 'pull_request' || !item.url) throw new Error('This item is not a pull request.');
    if (item.status !== 'open') return item;
    const crew = await loadCrew();
    const { method } = await mergePullRequest(codeSettings(crew.config.code), item.url);
    const session = this.store.session(item.sessionId);
    const what = item.title.replace(/^Pull request /, '').split(':')[0];
    if (session) this.emit(session, null, { type: 'status', text: `The owner merged pull request ${what} (${method}): ${item.url}` });
    return this.resolveInbox(id) ?? item;
  }

  private resolveInboxOf(threadId: string, kinds: InboxKind[], sessionId?: string): void {
    for (const item of this.store.openInboxOfThread(threadId, kinds)) {
      if (!sessionId || item.sessionId === sessionId) this.resolveInbox(item.id);
    }
  }

  // -------------------------------------------------------------------------
  // Read models

  private withMeta(t: Omit<Thread, 'roles' | 'statusText' | 'usage'>): Thread {
    const sessions = this.store.sessionsOfThread(t.id);
    const roles = [...new Set(sessions.map((s) => s.role))];
    let statusText = '';
    if (t.status === 'needs_you') statusText = 'Needs you';
    else if (t.status === 'interrupted') statusText = 'Interrupted';
    else if (t.status === 'error') statusText = 'Failed';
    else if (t.status === 'running') {
      const busy = sessions.filter((s) => s.status === 'running').at(-1);
      const last = busy && this.store.lastEventOfSession(busy.id, ['tool_call', 'subagent_started']);
      if (last?.type === 'subagent_started') statusText = `Waiting for ${last.role}`;
      else if (last?.type === 'tool_call') statusText = `Using ${last.name.replace(/^mcp__\w+?__/, '')}`;
      else statusText = 'Working';
    } else {
      statusText = this.store.latestDocStatusOfThread(t.id) === 'draft' ? 'Draft to review' : 'Done';
    }
    return { ...t, roles, statusText, usage: this.store.usageOfThread(t.id) };
  }

  async roles(): Promise<RoleSummary[]> {
    const crew = await loadCrew();
    return Object.values(crew.agents).map((a) => ({
      name: a.name,
      label: a.label,
      description: a.description,
      engine: a.engine,
      model: a.model,
      permissions: a.permissions,
      isLead: a.isLead,
    }));
  }

  activity(): AgentActivity[] {
    return this.store.sessionsWithStatus('running', 'queued', 'interrupted').map((s) => {
      const thread = this.store.thread(s.threadId);
      const turn = this.store.lastTurnOfSession(s.id);
      const last = this.store.lastEventOfSession(s.id, ['tool_call', 'message', 'subagent_started']);
      let doing = s.status === 'interrupted' ? 'Interrupted, waiting to resume' : 'Starting…';
      if (s.status !== 'interrupted' && last) {
        if (last.type === 'tool_call') doing = `Using ${last.name.replace(/^mcp__\w+?__/, '')}`;
        else if (last.type === 'subagent_started') doing = `Waiting for ${last.role}`;
        else if (last.type === 'message') doing = snippet(last.text, 90);
      }
      return {
        role: s.role,
        sessionId: s.id,
        threadId: s.threadId,
        threadTitle: thread?.title ?? '',
        status: s.status,
        doing,
        since: turn?.startedAt ?? s.updatedAt,
      };
    });
  }

  async state(): Promise<StateResponse> {
    const crew = await loadCrew();
    return {
      team: {
        name: crew.config.name,
        suggestions: crew.config.suggestions ?? [],
        fonts: crew.fonts.filter((f) => existsSync(f.file)).map(({ file: _file, ...f }) => f),
      },
      threads: this.store.threads().filter((t) => !t.archived).map((t) => this.withMeta(t)),
      done: this.store.threads().filter((t) => t.archived).slice(0, 200).map((t) => this.withMeta(t)),
      inbox: this.store.openInbox(),
      roles: await this.roles(),
      activity: this.activity(),
    };
  }

  threadDetail(threadId: string): ThreadDetailResponse | undefined {
    const thread = this.store.thread(threadId);
    if (!thread) return undefined;
    return {
      thread: this.withMeta(thread),
      sessions: this.store.sessionsOfThread(threadId),
      turns: this.store.turnsOfThread(threadId),
      events: this.store.eventsOfThread(threadId),
    };
  }

  // -------------------------------------------------------------------------
  // Threads and messages

  private createSession(crew: LoadedCrew, threadId: string, agentName: string, parent: SessionRow | null): SessionRow {
    const agent = crew.agents[agentName];
    if (!agent) throw new Error(`Unknown agent "${agentName}"`);
    const id = newId('s');
    const now = Date.now();
    const session: SessionRow = {
      id,
      threadId,
      role: agent.name,
      engine: agent.engine,
      model: agent.model,
      status: 'idle',
      // Claude Code and Grok accept a session id up front; Codex and Antigravity report their own.
      engineSessionId: agent.engine === 'codex' || agent.engine === 'antigravity' ? null : randomUUID(),
      engineSessionStarted: false,
      parentSessionId: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 0,
      workdir: join(paths.sessions, threadId, `${agent.name}-${id.slice(2)}`),
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertSession(session);
    this.broadcast({ kind: 'session', session });
    return session;
  }

  async createThread(text: string, roleName?: string, uploads?: AttachmentUpload[], benchedNames: string[] = []): Promise<Thread> {
    const crew = await loadCrew();
    const role = roleName ?? crew.lead;
    if (!crew.agents[role]) throw new Error(`Unknown agent "${role}". Agents: ${Object.keys(crew.agents).join(', ')}`);
    const benched = [...new Set(benchedNames)];
    for (const name of benched) {
      const a = crew.agents[name];
      if (!a || a.isLead) throw new Error(`"${name}" is not a specialist on this team.`);
    }
    const now = Date.now();
    const threadId = newId('t');
    const rootId = 'pending';
    const attachments = saveAttachments(threadId, uploads);
    text = text.trim() || (attachments.length ? 'See the attached image.' : text);
    const thread = { id: threadId, title: titleFrom(text), status: 'running' as const, rootSessionId: rootId, createdAt: now, updatedAt: now, archived: false, benched };
    // Insert the thread first (sessions reference it), then point it at its root.
    this.store.insertThread(thread);
    const root = this.createSession(crew, threadId, role, null);
    this.store.db.prepare('UPDATE threads SET root_session_id = ? WHERE id = ?').run(root.id, threadId);
    const saved = this.withMeta(this.store.thread(threadId)!);
    this.broadcast({ kind: 'thread', thread: saved });

    this.emit(root, null, { type: 'message', role: 'user', text, from: 'owner', ...(attachments.length ? { attachments } : {}) });
    void this.enqueueTurn(root.id, text + attachmentNote(attachments), { images: attachments.map((a) => a.file) });
    void this.autoTitle(crew.agents[crew.lead] ?? crew.agents[role]!, threadId, text);
    return saved;
  }

  /**
   * Replaces the first-line placeholder title with a short one from a small model,
   * on the lead's engine and the owner's subscription. Best effort: on any failure
   * the placeholder stays. Cancelled when the thread is renamed or closed first.
   */
  private async autoTitle(lead: LoadedAgent, threadId: string, text: string): Promise<void> {
    if (!text.trim() || this.shuttingDown) return;
    const dir = join(paths.run, `title-${threadId}`);
    const controller = new AbortController();
    this.titleJobs.set(threadId, controller);
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const run = (model: string) => engines[lead.engine].run({
        workdir: dir,
        runDir: dir,
        model,
        reasoning: lead.engine === 'codex' ? 'low' : undefined,
        permissions: 'read-only',
        prompt: TITLE_PROMPT(text),
        resumeId: null,
        mcpServers: {},
        denyPaths: denyPaths(),
        webAccess: false,
        oneShot: true,
        signal: controller.signal,
        onEvent: () => {},
      });
      const small = TITLE_MODELS[lead.engine];
      let result = await run(small ?? lead.model);
      if (!result.ok && small && small !== lead.model && !controller.signal.aborted) result = await run(lead.model);
      const title = result.ok ? cleanTitle(result.finalText) : '';
      const current = this.store.thread(threadId);
      if (controller.signal.aborted || !title || !current || current.archived) return;
      this.setTitle(threadId, title);
    } catch {
      // Keep the placeholder.
    } finally {
      clearTimeout(timer);
      if (this.titleJobs.get(threadId) === controller) this.titleJobs.delete(threadId);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Left for the next start; harmless.
      }
    }
  }

  private cancelAutoTitle(threadId: string): void {
    this.titleJobs.get(threadId)?.abort();
    this.titleJobs.delete(threadId);
  }

  /** Changes the title only: a rename is not activity, so the sidebar order stays. */
  private setTitle(threadId: string, title: string): void {
    this.broadcast({ kind: 'thread', thread: this.withMeta(this.store.setThreadTitle(threadId, title)) });
  }

  private renameThread(session: SessionRow, raw: string): string {
    if (session.depth !== 0) throw new Error('Only the agent that owns the thread can rename it.');
    if (this.store.thread(session.threadId)?.archived) throw new Error('This thread is closed.');
    const title = cleanTitle(raw);
    if (!title) throw new Error('Give the thread a title.');
    this.cancelAutoTitle(session.threadId);
    this.setTitle(session.threadId, title);
    return `Renamed the thread to "${title}".`;
  }


  sendMessage(threadId: string, text: string, sessionId?: string, replyTo?: string, uploads?: AttachmentUpload[]): { sessionId: string } {
    const thread = this.store.thread(threadId);
    if (!thread) throw new Error(`No thread ${threadId}`);
    if (thread.archived) throw new Error('This thread is closed.');
    const session = this.store.session(sessionId ?? thread.rootSessionId);
    if (!session || session.threadId !== threadId) throw new Error('That session is not part of this thread');

    let question: InboxItem | undefined;
    if (replyTo) {
      // An answer to one question resolves that question only. A second answer
      // (a stale card, another device, a retry) would start another turn.
      const item = this.store.inboxItem(replyTo);
      if (!item || item.sessionId !== session.id || item.kind !== 'needs_you') {
        throw new Error('That question does not belong to this agent.');
      }
      if (item.status !== 'open') throw new Error('This question was already answered or dismissed.');
      question = item;
    } else {
      // A plain reply while exactly one question is open answers that question.
      const open = this.store.openInboxOfThread(threadId, ['needs_you']).filter((i) => i.sessionId === session.id);
      if (open.length === 1) question = open[0];
    }
    if (question) this.resolveInbox(question.id);
    const answers = question?.id;
    const answered = Boolean(question);
    if (session.depth === 0) this.resolveInboxOf(threadId, ['error']);

    const attachments = saveAttachments(threadId, uploads);
    text = text.trim() || (attachments.length ? 'See the attached image.' : text);
    // An answer names its question: with several open, a bare "Yes" is ambiguous.
    const promptOf = (t: string) =>
      (question
        ? `The owner answered your question "${snippet(question.body, 300)}":\n\n${t}`
        : session.depth === 0
          ? t
          : `Message from the owner, who stepped into your work:\n\n${t}`) + attachmentNote(attachments);
    const prompt = promptOf(text);
    const images = attachments.map((a) => a.file);
    const message = {
      type: 'message',
      role: 'user',
      text,
      from: 'owner',
      ...(attachments.length ? { attachments } : {}),
      ...(answers ? { replyTo: answers } : {}),
    } as const;

    // Steer: the agent is working and its engine can take the message into the
    // running turn, so it reads it at its next step. Not when other messages
    // are already queued (they go first), and not for a specialist's answer to
    // its own question (that reply has to reach whoever asked it for work).
    const run = this.running.get(session.id);
    const queued = (this.pending.get(session.id) ?? 0) > 0;
    if (steeringEnabled && run?.steer && !queued && !(answered && session.depth > 0)) {
      // The images must be in the agent's folder before it reads the message;
      // a new turn copies them at its start, a steered message has to do it here.
      if (images.length) syncAttachments(threadId, session.workdir);
      const read = run.steer(prompt, images.map((f) => join(session.workdir, 'attachments', f)));
      const event = this.emit(session, run.turnId, { ...message, delivery: 'steer' });
      read.then(
        () => this.emit(session, run.turnId, { type: 'message_delivery', messageId: event.id, state: 'read' }),
        () => {
          // The turn ended before the agent read it. Stopped: the message is
          // dropped with the rest of the work. Otherwise it becomes the next turn.
          if ((run.controller.signal.reason as AbortReason | undefined) === 'stop') return;
          const turnId = newId('u');
          this.emit(session, run.turnId, { type: 'message_delivery', messageId: event.id, state: 'requeued', nextTurnId: turnId });
          void this.enqueueTurn(session.id, prompt, { turnId, images });
        },
      );
      return { sessionId: session.id };
    }

    // Queue: the message waits for the current turn to end. It is tagged with
    // the turn that will deliver it, so the app can show it as queued until
    // that turn starts.
    const busy = Boolean(run) || queued;
    const turnId = newId('u');
    const event = this.emit(session, busy ? turnId : null, busy ? { ...message, delivery: 'queue' } : message);
    const queuedMessage: QueuedMessage | undefined = busy
      ? { eventId: event.id, sessionId: session.id, prompt: promptOf, text, removed: false, replyTo: answers }
      : undefined;
    if (queuedMessage) this.queuedMessages.set(event.id, queuedMessage);
    void this.enqueueTurn(session.id, prompt, { turnId, notifyParent: answered && session.depth > 0, images, queuedMessage });
    return { sessionId: session.id };
  }

  /** Change a queued owner message before the agent has it. */
  editQueuedMessage(eventId: number, text: string): void {
    const q = this.takeQueued(eventId);
    text = text.trim();
    if (!text) throw new Error('The message is empty.');
    q.text = text;
    this.emit(this.store.session(q.sessionId)!, null, { type: 'message_delivery', messageId: eventId, state: 'edited', text });
  }

  /** Take back a queued owner message before the agent has it. */
  removeQueuedMessage(eventId: number): void {
    const q = this.takeQueued(eventId);
    q.removed = true;
    this.queuedMessages.delete(eventId);
    const session = this.store.session(q.sessionId)!;
    this.emit(session, null, { type: 'message_delivery', messageId: eventId, state: 'removed' });
    // The answer was taken back: the question is open again.
    if (q.replyTo) {
      const item = this.store.reopenInbox(q.replyTo);
      if (item) {
        this.broadcast({ kind: 'inbox', item });
        this.refreshThread(item.threadId);
      }
    }
  }

  private takeQueued(eventId: number): QueuedMessage {
    const q = this.queuedMessages.get(eventId);
    if (!q || q.removed) throw new Error('The agent already has this message.');
    return q;
  }

  /** Continue an interrupted or failed session through the CLI's own resume. */
  resumeSession(sessionId: string): void {
    const session = this.store.session(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    if (this.store.thread(session.threadId)?.archived) throw new Error('This thread is closed.');
    if (this.running.has(sessionId)) throw new Error('This session is already running');
    this.resolveInboxOf(session.threadId, ['interrupted', 'error'], session.depth === 0 ? undefined : session.id);
    // Owner messages that were still waiting in the queue when Crew stopped.
    const unseen = this.store
      .turnsOfThread(session.threadId)
      .filter((t) => t.sessionId === sessionId && t.status === 'interrupted' && t.error === NOT_STARTED);
    for (const t of unseen) this.store.finishTurn(t.id, 'cancelled', null, 'Replayed on resume');
    void this.enqueueTurn(
      sessionId,
      'Crew was restarted while you were working, so your last turn was interrupted. Continue the task where you left off. ' +
        'Any specialist you were waiting on was interrupted too: call them again if you still need their answer ' +
        '(they keep the work they already did).' +
        (unseen.length
          ? `\n\nThe owner also sent ${unseen.length === 1 ? 'this message' : 'these messages'} while you were busy, which you have not seen yet:\n\n` +
            unseen.map((t) => t.prompt).join('\n\n---\n\n')
          : ''),
      { resumed: true },
    );
  }

  resumeThread(threadId: string): void {
    const thread = this.store.thread(threadId);
    if (!thread) throw new Error(`No thread ${threadId}`);
    this.resumeSession(thread.rootSessionId);
  }

  stopSession(sessionId: string): void {
    const session = this.store.session(sessionId);
    if (!session) return;
    // Stop everything this session delegated to as well.
    const all = this.store.sessionsOfThread(session.threadId);
    const stopTree = (id: string) => {
      // Turns already waiting in this session's queue are dropped as well.
      this.stopGen.set(id, (this.stopGen.get(id) ?? 0) + 1);
      this.running.get(id)?.controller.abort('stop' satisfies AbortReason);
      for (const child of all.filter((s) => s.parentSessionId === id)) stopTree(child.id);
    };
    stopTree(sessionId);
  }

  archiveThread(threadId: string): void {
    const thread = this.store.thread(threadId);
    if (!thread) return;
    this.stopSession(thread.rootSessionId);
    this.cancelAutoTitle(threadId);
    this.resolveInboxOf(threadId, ['needs_you', 'approval', 'interrupted', 'error', 'draft']);
    this.broadcast({ kind: 'thread', thread: this.withMeta(this.store.updateThread(threadId, { archived: true })) });
  }

  // -------------------------------------------------------------------------
  // Turns

  private enqueueTurn(sessionId: string, prompt: string, opts: TurnOptions = {}): Promise<TurnOutcome> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const gen = this.stopGen.get(sessionId) ?? 0;
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? 0) + 1);
    const next = prev.catch(() => {}).then(() => {
      // A queued owner message is fixed from here: it was edited, or taken back.
      const q = opts.queuedMessage;
      if (q) {
        this.queuedMessages.delete(q.eventId);
        if (q.removed) return this.skipTurn(sessionId, { ...opts, quiet: true });
        prompt = q.prompt(q.text);
      }
      if (this.shuttingDown) return this.skipTurn(sessionId, opts, prompt);
      if ((this.stopGen.get(sessionId) ?? 0) !== gen || opts.signal?.aborted) return this.skipTurn(sessionId, opts);
      return this.runTurn(sessionId, prompt, opts);
    });
    this.queues.set(sessionId, next);
    void next.finally(() => {
      if (this.queues.get(sessionId) === next) this.queues.delete(sessionId);
    });
    return next;
  }

  private buildMcp(crew: LoadedCrew, agent: LoadedAgent, session: SessionRow, canDelegate: boolean): Record<string, McpServerSpec> {
    const subagents = canDelegate
      ? Object.values(crew.agents)
          .filter((a) => !a.isLead && !this.benchedIn(session.threadId).includes(a.name))
          .map((a) => ({ tool: subagentToolName(a.name), name: a.name, label: a.label, description: a.description }))
      : [];
    const servers: Record<string, McpServerSpec> = {
      crew: {
        command: process.execPath,
        args: [paths.bridge],
        env: {
          ...nodeChildEnv,
          CREW_URL: `http://127.0.0.1:${port}`,
          CREW_SESSION_ID: session.id,
          CREW_THREAD_ID: session.threadId,
          CREW_AGENT: agent.name,
          CREW_CAN_SAVE_ARTIFACTS: agent.isLead ? '0' : '1',
          CREW_CAN_RENAME_THREAD: agent.isLead && session.depth === 0 ? '1' : '0',
          CREW_CAN_CODE: agent.permissions === 'code' ? '1' : '0',
          CREW_HAS_THEME: crew.config.code?.theme ? '1' : '0',
          CREW_TOOL_FILES: JSON.stringify(agent.tools.map((t) => t.file)),
          CREW_SUBAGENTS: JSON.stringify(subagents),
          CREW_MEMORIES: JSON.stringify(agent.memories.map((m) => ({ name: m.name, description: m.def.description }))),
        },
        // Kept off command lines and config files.
        secretEnv: { CREW_BRIDGE_TOKEN: this.bridgeToken(session.id) },
        toolTimeoutSec: 60 * 60,
        approve: 'all',
      },
    };
    for (const [name, c] of Object.entries(agent.connections)) {
      const env: Record<string, string> = {};
      const secretEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.env ?? {})) {
        if (typeof v === 'string') env[k] = v;
        else if (process.env[v.fromEnv]) secretEnv[k] = process.env[v.fromEnv]!;
      }
      // Codex and Grok sessions run with their own HOME; MCP servers like the Shopify CLI need the real one.
      env.HOME = REAL_HOME;
      // Where a connection may keep images for this thread (the browser's screenshot keep: true).
      // They sit with the owner's attachments, so every agent's attachments/ folder gets them.
      env.CREW_IMAGES_DIR = join(paths.attachments, session.threadId);
      // Keeps each session's browser tabs to itself (guard.ts suffixes the browser session names).
      env.CREW_BROWSER_SCOPE = session.id;
      servers[name] = {
        command: c.command,
        args: c.args ?? [],
        env,
        secretEnv,
        toolTimeoutSec: c.toolTimeoutSec ?? 120,
        approve: 'read-only',
        allowTools: c.tools.allow,
      };
      // The agent's own tools/*.ts run in the crew bridge and may call the same
      // service (studio_generate next to the Studio connection): same secrets.
      if (agent.tools.length) Object.assign(servers.crew!.secretEnv, secretEnv);
    }
    return servers;
  }

  /** Specialists the owner switched off for this thread. */
  private benchedIn(threadId: string): string[] {
    return this.store.thread(threadId)?.benched ?? [];
  }

  private recallMemories(agent: LoadedAgent): MemoryRecall[] {
    return agent.memories.map((m) => ({
      name: m.name,
      description: m.def.description,
      entries: this.store.memories(agent.name, m.name).map((e) => ({ id: e.id, text: e.text })),
    }));
  }

  /**
   * A queued turn that never runs: stopped by the owner, or Crew is shutting
   * down. In the second case an owner message is saved and replayed on Resume.
   */
  private skipTurn(sessionId: string, opts: TurnOptions, savePrompt?: string): TurnOutcome {
    const left = Math.max(0, (this.pending.get(sessionId) ?? 1) - 1);
    this.pending.set(sessionId, left);
    const turnId = opts.turnId ?? newId('u');
    const session = this.store.session(sessionId);
    if (session && savePrompt !== undefined && !opts.callerSessionId && !opts.resumed) {
      const now = Date.now();
      this.store.insertTurn({
        id: turnId, sessionId, threadId: session.threadId, prompt: savePrompt, status: 'interrupted',
        callerSessionId: null, result: null, error: NOT_STARTED, startedAt: now, endedAt: now, usage: null,
      });
      return { turnId, status: 'interrupted', text: '', error: NOT_STARTED };
    }
    if (session && savePrompt === undefined && !opts.quiet) {
      this.emit(session, opts.turnId ?? null, { type: 'status', text: 'A queued message was dropped because the work was stopped.' });
    }
    if (session && !this.running.has(sessionId) && left === 0 && !this.shuttingDown) {
      const s = this.setSession(sessionId, { status: 'idle' });
      this.refreshThread(s.threadId);
    }
    return { turnId, status: 'cancelled', text: '', error: 'Stopped before it started' };
  }

  private async runTurn(sessionId: string, prompt: string, opts: TurnOptions): Promise<TurnOutcome> {
    this.pending.set(sessionId, Math.max(0, (this.pending.get(sessionId) ?? 1) - 1));
    let session = this.store.session(sessionId)!;
    const turnId = opts.turnId ?? newId('u');
    const startedAt = Date.now();
    this.store.insertTurn({
      id: turnId,
      sessionId,
      threadId: session.threadId,
      prompt,
      status: 'running',
      callerSessionId: opts.callerSessionId ?? null,
      result: null,
      error: null,
      startedAt,
      endedAt: null,
      usage: null,
    });

    const controller = new AbortController();
    let resolveDone!: (o: TurnOutcome) => void;
    const done = new Promise<TurnOutcome>((r) => (resolveDone = r));
    this.running.set(sessionId, { turnId, controller, done, steer: null });

    session = this.setSession(sessionId, { status: 'running' });
    this.refreshThread(session.threadId);
    const callerRole = opts.callerSessionId ? this.store.session(opts.callerSessionId)?.role : undefined;
    this.emit(session, turnId, { type: 'turn_started', prompt, resumed: Boolean(opts.resumed), callerRole });

    // A turn on a specialist that was not started by the lead (the owner
    // stepped in, answered a question or resumed) still shows up as a card
    // in the caller's chat.
    const parent = session.parentSessionId ? this.store.session(session.parentSessionId) : undefined;
    const showCardInParent = parent && !opts.callerSessionId;
    if (showCardInParent) {
      this.emit(parent, this.running.get(parent.id)?.turnId ?? null, {
        type: 'subagent_started',
        childSessionId: session.id,
        childTurnId: turnId,
        role: session.role,
        engine: session.engine,
        model: session.model,
        brief: opts.resumed ? 'Resuming after a restart' : `Owner: ${prompt.replace(/^Message from the owner[^\n]*\n\n/, '')}`,
      });
    }

    const onCallerGone = () => controller.abort('stop' satisfies AbortReason);
    opts.signal?.addEventListener('abort', onCallerGone, { once: true });

    let outcome: TurnOutcome;
    let usage: Usage | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const crew = await loadCrew();
      const agent = crew.agents[session.role];
      if (!agent) throw new Error(`Agent "${session.role}" no longer exists in packages/crew/agent`);
      const limits = crew.limits;
      const minutes = session.depth === 0 ? limits.threadTurnTimeoutMinutes : limits.turnTimeoutMinutes;
      timer = setTimeout(() => controller.abort('timeout' satisfies AbortReason), minutes * 60_000);

      // Only the lead, in the thread it owns, calls specialists.
      const canDelegate = agent.isLead && session.depth === 0;
      if (agent.permissions === 'code') {
        const title = this.store.thread(session.threadId)?.title ?? '';
        const fresh = !existsSync(join(session.workdir, 'repo', '.git'));
        if (fresh) this.emit(session, turnId, { type: 'status', text: `Getting a fresh copy of ${crew.config.code?.repo ?? 'the code repo'}…` });
        await ensureCheckout(codeSettings(crew.config.code), session.workdir, session.id, title);
      }
      translateAgent({
        crew,
        agent,
        engine: session.engine,
        workdir: session.workdir,
        canDelegate,
        benched: this.benchedIn(session.threadId),
        memories: this.recallMemories(agent),
      });
      syncAttachments(session.threadId, session.workdir);

      const adapter = engines[session.engine];
      const onEvent = (e: EngineEvent) => {
        switch (e.kind) {
          case 'session':
            session = this.setSession(sessionId, { engineSessionId: e.engineSessionId, engineSessionStarted: true });
            break;
          case 'text':
            this.emit(session, turnId, { type: 'message', role: 'assistant', text: e.text, from: session.role });
            break;
          case 'thinking':
            this.emit(session, turnId, { type: 'thinking', text: e.text });
            break;
          case 'tool_call':
            this.emit(session, turnId, { type: 'tool_call', callId: e.callId, name: e.name, input: e.input });
            break;
          case 'tool_result':
            this.emit(session, turnId, { type: 'tool_result', callId: e.callId, output: e.output, isError: e.isError });
            break;
        }
      };
      const base = {
        workdir: session.workdir,
        runDir: join(paths.run, session.id),
        model: session.model,
        reasoning: agent.reasoning,
        permissions: agent.permissions,
        mcpServers: this.buildMcp(crew, agent, session, canDelegate),
        denyPaths: denyPaths(),
        // Off by default for an agent that can read store or customer data, so it cannot send that data out.
        webAccess: agent.webAccess,
        signal: controller.signal,
        onEvent,
        onSpawn: (pid: number) => this.store.setTurnPid(turnId, pid),
        onSteer: (steer: Steer | null) => {
          const r = this.running.get(sessionId);
          if (r?.turnId === turnId) r.steer = steer;
        },
        images: (opts.images ?? []).map((f) => join(session.workdir, 'attachments', f)),
      };

      const canResume = session.engineSessionStarted && session.engineSessionId;
      let result = await adapter.run({
        ...base,
        prompt,
        resumeId: canResume ? session.engineSessionId : null,
        newSessionId: canResume ? undefined : (session.engineSessionId ?? undefined),
      });

      usage = result.usage;
      if (!result.ok && result.resumeFailed && !controller.signal.aborted) {
        // The CLI lost the conversation (for example it was killed before saving). Start fresh.
        this.emit(session, turnId, { type: 'status', text: 'Could not restore the earlier conversation; starting a fresh session.' });
        const freshId = session.engine === 'codex' || session.engine === 'antigravity' ? null : randomUUID();
        session = this.setSession(sessionId, { engineSessionId: freshId, engineSessionStarted: false });
        result = await adapter.run({
          ...base,
          prompt: `(Your earlier conversation in this thread could not be restored.)\n\n${prompt}`,
          resumeId: null,
          newSessionId: freshId ?? undefined,
        });
        usage = addUsage(usage, result.usage);
      }

      if (result.ok) {
        outcome = { turnId, status: 'done', text: result.finalText };
      } else {
        const reason = controller.signal.reason as AbortReason | undefined;
        if (controller.signal.aborted && reason === 'shutdown') outcome = { turnId, status: 'interrupted', text: result.finalText, error: 'Crew was shut down' };
        else if (controller.signal.aborted && reason === 'stop') outcome = { turnId, status: 'cancelled', text: result.finalText, error: 'Stopped' };
        else if (controller.signal.aborted && reason === 'timeout') outcome = { turnId, status: 'error', text: result.finalText, error: `Timed out after ${minutes} minutes` };
        else outcome = { turnId, status: 'error', text: result.finalText, error: result.error ?? 'Unknown error' };
      }
    } catch (err) {
      outcome = { turnId, status: 'error', text: '', error: (err as Error).message };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onCallerGone);
    }

    this.store.finishTurn(turnId, outcome.status, outcome.text || null, outcome.error ?? null, usage);
    this.running.delete(sessionId);
    const queued = (this.pending.get(sessionId) ?? 0) > 0;
    const sessionStatus =
      outcome.status === 'interrupted' ? 'interrupted' : outcome.status === 'error' ? 'error' : queued ? 'queued' : 'idle';
    session = this.setSession(sessionId, { status: sessionStatus });
    this.emit(session, turnId, { type: 'turn_done', status: outcome.status, durationMs: Date.now() - startedAt, error: outcome.error, usage });

    if (showCardInParent) {
      this.emit(parent, this.running.get(parent.id)?.turnId ?? null, {
        type: 'subagent_done',
        childSessionId: session.id,
        childTurnId: turnId,
        role: session.role,
        status: outcome.status,
        result: outcome.text || outcome.error || '',
        durationMs: Date.now() - startedAt,
      });
    }

    // The GM asked this specialist for work, the specialist asked the owner, and
    // the owner has now answered: hand the specialist's new reply to the GM.
    if (opts.notifyParent && outcome.status === 'done' && parent && !this.shuttingDown) {
      void this.enqueueTurn(
        parent.id,
        `Update from ${session.role}: the owner answered their question, and they replied:\n\n${outcome.text}\n\n` +
          'Take this into account and continue the task.',
      );
    }

    if (outcome.status === 'error' && session.depth === 0) {
      this.addInbox(session, 'error', 'A turn failed', outcome.error ?? 'Unknown error');
    }
    if (outcome.status === 'interrupted' && session.depth === 0) {
      const title = this.store.thread(session.threadId)?.title ?? '';
      this.addInbox(session, 'interrupted', `Interrupted: ${title}`, 'Crew stopped while this thread was working. Resume to continue where it left off.');
    }
    this.refreshThread(session.threadId);
    resolveDone(outcome);
    return outcome;
  }

  /** An attached image for the app, or undefined. */
  /** A team font file (crew.config.ts `fonts`), for the app: /api/brand-fonts/<role>. */
  async brandFontFile(role: string): Promise<{ mime: string; data: Buffer } | undefined> {
    const font = (await loadCrew()).fonts.find((f) => f.role === role);
    if (!font || !existsSync(font.file)) return undefined;
    const ext = font.file.split('.').pop()!.toLowerCase();
    return { mime: `font/${ext}`, data: readFileSync(font.file) };
  }

  attachmentFile(threadId: string, file: string): { mime: string; data: Buffer } | undefined {
    if (!/^[\w-]+$/.test(threadId) || !/^[\w.-]+$/.test(file) || file.startsWith('.')) return undefined;
    const p = join(paths.attachments, threadId, file);
    if (!existsSync(p)) return undefined;
    const ext = file.split('.').pop() ?? '';
    const mime = Object.entries(ATTACHMENT_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    return { mime, data: readFileSync(p) };
  }

  // -------------------------------------------------------------------------
  // Tools served through the MCP bridge

  async handleTool(sessionId: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const session = this.store.session(sessionId);
    if (!session) throw new Error('Unknown session');
    const crew = await loadCrew();
    const agent = crew.agents[session.role];
    if (!agent) throw new Error(`Agent "${session.role}" no longer exists`);

    // The bridge asks before it runs one of the agent's own tools/*.ts.
    if (tool === 'approve') {
      const name = String(args.tool ?? '');
      const def = agent.tools.find((t) => t.name === name);
      if (!def) throw new Error(`Unknown tool ${name}`);
      await this.requireApproval(session, agent, name, (args.input ?? {}) as Record<string, unknown>, def.approval, signal);
      return 'approved';
    }

    await this.requireApproval(session, agent, tool, args, undefined, signal);

    if (agent.isLead && session.depth === 0) {
      const sub = Object.values(crew.agents).find((a) => !a.isLead && subagentToolName(a.name) === tool);
      if (sub && this.benchedIn(session.threadId).includes(sub.name)) {
        throw new Error(`The owner switched the ${sub.label} off for this thread. Do this part yourself or with the specialists you have.`);
      }
      if (sub) return this.callSubagent(crew, session, sub, String(args.message ?? ''), signal);
    }

    const mem = /^([a-z][a-z0-9_]*)__(save|remove)_memory$/.exec(tool);
    if (mem) {
      const memory = agent.memories.find((m) => m.name === mem[1]);
      if (!memory) throw new Error(`You have no memory called ${mem[1]}`);
      return mem[2] === 'save'
        ? this.saveMemory(session, agent, memory.name, memory.def.maxEntries ?? 50, String(args.text ?? ''))
        : this.removeMemory(session, agent, memory.name, String(args.id ?? ''));
    }

    switch (tool) {
      case 'rename_thread':
        if (!agent.isLead) throw new Error('Only the lead renames threads.');
        return this.renameThread(session, String(args.title ?? ''));
      case 'ask_owner':
        return this.askOwner(session, args);
      case 'show_preview':
        return this.showPreview(session, agent, args);
      case 'save_artifact':
        if (agent.isLead) throw new Error('The lead hands work back; specialists save artifacts.');
        return this.saveArtifact(session, agent, args);
      case 'read_artifact':
        return this.readArtifact(session, String(args.id ?? ''));
      case 'list_docs':
        return this.listDocs(session);
      case 'theme_preview':
      case 'code_review':
      case 'open_pull_request':
        if (agent.permissions !== 'code') throw new Error(`${tool} is only for agents with permissions 'code'.`);
        return this.codeTool(crew, session, tool, args, signal);
      default:
        throw new Error(`Unknown tool ${tool}`);
    }
  }

  private async codeTool(crew: LoadedCrew, session: SessionRow, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const settings = codeSettings(crew.config.code);
    const turnId = this.running.get(session.id)?.turnId ?? null;
    if (tool === 'theme_preview') {
      const p = await themePreview(settings, session.workdir, session.id, crew.config.shopify?.store, signal);
      this.emit(session, turnId, { type: 'status', text: `Theme preview of ${p.branch}: ${p.previewUrl}` });
      return [
        `Pushed ${p.branch} to the development theme ${p.themeId}.`,
        `Preview: ${p.previewUrl}`,
        p.editorUrl ? `Theme editor: ${p.editorUrl}` : '',
        'The link shows whichever branch was pushed last; push again right before sharing it. The storefront may ask for its password.',
      ].filter(Boolean).join('\n');
    }
    if (tool === 'code_review') {
      const { stat, diff } = await branchDiff(settings, session.workdir, session.id, signal);
      if (!stat) return `There are no changes against ${settings.base} to review.`;
      const max = 150_000;
      const shown = diff.length > max ? `${diff.slice(0, max)}\n… (diff cut at ${max} characters; read the rest of the files yourself)` : diff;
      // The reviewer works in a snapshot of the branch: no symlinks, hooks or tool settings the agent could have planted.
      const dir = await snapshot(session.workdir, session.id, undefined, signal);
      const runDir = `${dir}-run`;
      try {
        const rules = ['AGENTS.md', settings.themePath ? join(settings.themePath, 'AGENTS.md') : '']
          .filter(Boolean)
          .map((f) => join(dir, f))
          .filter((f) => existsSync(f))
          .map((f) => readFileSync(f, 'utf8'))
          .join('\n\n---\n\n');
        const { engine, model, reasoning } = parseModel(settings.reviewer);
        this.emit(session, turnId, { type: 'status', text: `Code review by ${model}…` });
        mkdirSync(runDir, { recursive: true, mode: 0o700 });
        const result = await engines[engine].run({
          workdir: dir,
          runDir,
          model,
          reasoning,
          permissions: 'read-only',
          prompt: REVIEW_PROMPT(shown, stat, typeof args.focus === 'string' ? args.focus : undefined, rules.slice(0, 40_000)),
          resumeId: null,
          newSessionId: engine === 'claude-code' ? randomUUID() : undefined,
          mcpServers: {},
          denyPaths: denyPaths(),
          webAccess: false,
          signal,
          onEvent: () => {},
        });
        if (!result.ok) throw new Error(`The review failed: ${result.error ?? 'no answer'}`);
        return `Review by ${model}:\n\n${result.finalText.trim()}`;
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(runDir, { recursive: true, force: true });
      }
    }
    // open_pull_request
    const title = String(args.title ?? '').trim();
    const body = String(args.body ?? '').trim();
    if (!title || !body) throw new Error('open_pull_request needs a title and a body.');
    const pr = await openPullRequest(
      settings,
      session.workdir,
      session.id,
      {
        title,
        body: `${body}\n\n---\nOpened by the ${crew.agents[session.role]?.label ?? session.role} in Crew.`,
        commitMessage: typeof args.commitMessage === 'string' ? args.commitMessage : undefined,
      },
      signal,
    );
    if (pr.created) {
      // The owner merges: the pull request waits for them in the Inbox.
      this.addInbox(session, 'pull_request', `Pull request #${pr.number}: ${title}`, `${body.split('\n\n')[0]!.slice(0, 600)}\n\n\`${pr.branch}\` · ${pr.stat.split('\n').pop()?.trim() ?? ''}`, { url: pr.url });
    }
    this.emit(session, turnId, { type: 'status', text: `${pr.created ? 'Opened' : 'Updated'} pull request #${pr.number}: ${pr.url}` });
    return `${pr.created ? 'Opened' : 'Updated'} pull request #${pr.number} from ${pr.branch}: ${pr.url}\n\n${pr.stat}`;
  }

  /**
   * Apply the agent's approval policy (agent.ts `approval`, else the tool's own
   * default). 'user-approval' puts an item in the Inbox and waits for the owner.
   */
  private async requireApproval(
    session: SessionRow,
    agent: LoadedAgent,
    toolName: string,
    input: Record<string, unknown>,
    toolDefault: 'user-approval' | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const decision = agent.def.approval?.({ toolName, input, agent: agent.name }) ?? toolDefault;
    if (!decision) return;
    if (decision === 'deny') throw new Error(`${toolName} is not allowed for the ${agent.label}.`);
    // The owner allowed this agent's tool, or everything ('*'), earlier in the thread.
    const key = `${agent.name}:${toolName}`;
    if (signal.aborted) throw new Error('The call was cancelled.');
    const allowed = this.store.allowedTools(session.threadId);
    if (allowed.includes(key) || allowed.includes('*')) return;

    const turnId = this.running.get(session.id)?.turnId ?? null;
    let shown = JSON.stringify(input, null, 2);
    if (shown.length > 3000) shown = shown.slice(0, 2999) + '…';
    const item = this.addInbox(
      session,
      'approval',
      `${agent.label} wants to run ${toolName}`,
      `${agent.label} wants to run \`${toolName}\` with:\n\n\`\`\`json\n${shown}\n\`\`\`\n\nApprove or deny.`,
    );
    this.emit(session, turnId, { type: 'approval', inboxId: item.id, toolName, input });
    this.refreshThread(session.threadId);

    const approved = await new Promise<boolean>((resolve) => {
      const settle = (ok: boolean) => {
        this.approvals.delete(item.id);
        resolve(ok);
      };
      this.approvals.set(item.id, { settle, threadId: session.threadId, key });
      if (signal.aborted) settle(false);
      else signal.addEventListener('abort', () => settle(false), { once: true });
    });
    if (this.store.inboxItem(item.id)?.status === 'open') this.resolveInbox(item.id);
    this.emit(session, turnId, { type: 'approval_done', inboxId: item.id, toolName, approved });
    this.refreshThread(session.threadId);
    if (!approved) {
      throw new Error(`The owner denied ${toolName}. Do not try again another way; carry on without it or explain what is blocked.`);
    }
  }

  /**
   * The owner's decision on an approval item. `always`: 'tool' also allows this
   * agent's tool for the rest of the thread, 'all' allows every tool in it; both
   * approve the matching calls already waiting.
   */
  decideApproval(inboxId: string, approved: boolean, always?: 'tool' | 'all'): InboxItem {
    const item = this.store.inboxItem(inboxId);
    if (!item || item.kind !== 'approval') throw new Error('No such approval');
    const waiter = this.approvals.get(inboxId);
    if (!waiter) {
      if (item.status === 'open') this.resolveInbox(inboxId);
      throw new Error('This approval is no longer waiting: the turn that asked for it has ended.');
    }
    // Save the grant first: if that fails, nothing has been released yet.
    if (approved && always) this.store.allowTool(waiter.threadId, always === 'all' ? '*' : waiter.key);
    waiter.settle(approved);
    const resolved = this.resolveInbox(inboxId) ?? item;
    if (approved && always) {
      for (const [id, other] of [...this.approvals]) {
        if (other.threadId !== waiter.threadId || (always === 'tool' && other.key !== waiter.key)) continue;
        if (!this.approvals.has(id)) continue; // settled meanwhile
        other.settle(true);
        this.resolveInbox(id);
      }
    }
    return resolved;
  }

  private async callSubagent(crew: LoadedCrew, caller: SessionRow, sub: LoadedAgent, brief: string, signal: AbortSignal): Promise<string> {
    if (caller.depth > 0) throw new Error('Specialists do not delegate. Do the work yourself or report what is missing.');
    if (!brief.trim()) throw new Error('The brief is empty.');

    // Reuse this caller's earlier session with the specialist, unless it is busy.
    const existing = this.store
      .sessionsOfThread(caller.threadId)
      .filter((s) => s.role === sub.name && s.parentSessionId === caller.id && !this.running.has(s.id))
      .at(-1);
    const child = existing ?? this.createSession(crew, caller.threadId, sub.name, caller);
    const wasInterrupted = existing?.status === 'interrupted';

    const callerLabel = crew.agents[caller.role]?.label ?? caller.role;
    const prompt =
      (wasInterrupted ? '(Your previous work in this thread was interrupted by a restart; you keep what you did so far.)\n\n' : '') +
      `Brief from ${callerLabel}:\n\n${brief}\n\n` +
      `Your final message is returned to ${callerLabel} as your answer. Save long work with save_artifact and return its id with a short summary.`;

    const childTurnId = newId('u');
    const callerTurnId = this.running.get(caller.id)?.turnId ?? null;
    this.emit(caller, callerTurnId, {
      type: 'subagent_started',
      childSessionId: child.id,
      childTurnId,
      role: sub.name,
      engine: child.engine,
      model: child.model,
      brief,
    });

    const started = Date.now();
    const outcome = await this.enqueueTurn(child.id, prompt, { turnId: childTurnId, callerSessionId: caller.id, signal });
    // Images the specialist kept (attachments/shot-…) are needed by the caller in this same turn.
    syncAttachments(caller.threadId, caller.workdir);

    this.emit(caller, callerTurnId, {
      type: 'subagent_done',
      childSessionId: child.id,
      childTurnId,
      role: sub.name,
      status: outcome.status,
      result: outcome.text || outcome.error || '',
      durationMs: Date.now() - started,
    });

    if (outcome.status === 'done') return outcome.text || `(${sub.label} finished without a written answer.)`;
    return `${sub.label} did not finish (${outcome.status}: ${outcome.error ?? 'no details'}).` + (outcome.text ? `\n\nPartial answer:\n${outcome.text}` : '');
  }

  private askOwner(session: SessionRow, args: Record<string, unknown>): string {
    const question = String(args.question ?? '').trim();
    if (!question) throw new Error('Write the question.');
    const { options, recommended, multiSelect } = questionOptions(args);
    const problem = questionProblem(question, Boolean(options));
    if (problem) throw new Error(`Not asked: ${problem}`);
    const item = this.addInbox(session, 'needs_you', question.split('\n')[0]!.slice(0, 140), question, { options, recommended, multiSelect });
    this.emit(session, this.running.get(session.id)?.turnId ?? null, {
      type: 'needs_you',
      question,
      inboxId: item.id,
      ...(options ? { options, recommended, multiSelect } : {}),
    });
    this.refreshThread(session.threadId);
    // The owner sees the question as a card; repeating it in chat only adds noise.
    // A specialist's last message goes to whoever asked it for work, so that one
    // still says it is waiting.
    return session.depth === 0
      ? "Your question is on the owner's screen as a card. End your turn now and write nothing else: no summary, no restating the question. Their answer arrives as a new message."
      : "Your question is in the owner's Inbox. End your turn now with one line for whoever asked you for work: what you asked the owner. Their answer arrives as a new message.";
  }

  private showPreview(session: SessionRow, agent: LoadedAgent, args: Record<string, unknown>): string {
    let title = typeof args.title === 'string' ? args.title.trim() : '';
    let content = typeof args.content === 'string' ? args.content : '';
    let format = docFormat(args.format);
    let artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : '';
    if (artifactId) {
      const a = this.store.artifact(artifactId);
      if (!a || a.threadId !== session.threadId) throw new Error(`No artifact ${artifactId} in this thread.`);
      content = a.content;
      format = a.format;
      title ||= a.title;
    }
    if (!content.trim()) throw new Error('Pass an artifactId, or content to show.');
    if (format === 'concepts') content = JSON.stringify(parseConceptBoard(content));
    title ||= 'Preview';

    // Everything the owner is shown is a doc (Docs tab): content written inline becomes one too.
    const now = Date.now();
    if (!artifactId) {
      artifactId = newId('a');
      this.store.insertArtifact({ id: artifactId, threadId: session.threadId, sessionId: session.id, agent: agent.name, title, format, content, createdAt: now });
    }
    this.store.markShown(artifactId, now);
    const previewId = newId('p');
    this.emit(session, this.running.get(session.id)?.turnId ?? null, { type: 'preview', previewId, title, format, content, artifactId });
    this.broadcastDoc(artifactId);
    // Only the thread owner's previews go to the Inbox; specialists' drafts usually feed into it.
    // Drafts go to Docs, not the Inbox: the Inbox is only for what blocks an agent.
    this.refreshThread(session.threadId);
    return `Shown to the owner in the preview panel as "${title}" (artifact ${artifactId}). The owner can approve it; list_docs shows which docs are approved.`;
  }

  private saveArtifact(session: SessionRow, agent: LoadedAgent, args: Record<string, unknown>): string {
    const title = String(args.title ?? '').trim();
    const format = docFormat(args.format);
    let content = String(args.content ?? '');
    if (!title || !content.trim()) throw new Error('An artifact needs a title and content.');
    if (format === 'concepts') content = JSON.stringify(parseConceptBoard(content));
    if (content.length > 200_000) throw new Error('Artifacts are capped at 200,000 characters. Split the work or shorten it.');
    const id = newId('a');
    this.store.insertArtifact({
      id,
      threadId: session.threadId,
      sessionId: session.id,
      agent: agent.name,
      title,
      format,
      content,
      createdAt: Date.now(),
    });
    this.emit(session, this.running.get(session.id)?.turnId ?? null, { type: 'status', text: `Saved artifact ${id}: ${title}` });
    return `Saved as artifact ${id} ("${title}", ${content.length} characters). Return this id with a short summary; do not paste the content.`;
  }

  private readArtifact(session: SessionRow, id: string): string {
    const a = this.store.artifact(id.trim());
    if (!a || a.threadId !== session.threadId) throw new Error(`No artifact ${id} in this thread.`);
    const status = a.status === 'approved' ? ', APPROVED by the owner: this is the version that counts' : '';
    return `# ${a.title}\n\n(artifact ${a.id} by ${a.agent}, ${a.format}${status})\n\n${a.content}`;
  }

  /** For agents: the docs the owner was shown in this thread, newest first, with their status. */
  private listDocs(session: SessionRow): string {
    const docs = this.store.docs(session.threadId);
    if (!docs.length) return 'No docs have been shown to the owner in this thread yet.';
    return docs.map((d) => `- ${d.id}: "${d.title}" by ${d.agent || 'unknown'}, ${d.status === 'approved' ? 'APPROVED' : 'draft'}${d.archivedAt ? ', archived' : ''}`).join('\n');
  }

  // -------------------------------------------------------------------------
  // Docs: what the owner has been shown, and whether they approved it

  private docSummary(a: Omit<ArtifactRow, 'content'>): DocSummary {
    return {
      id: a.id,
      threadId: a.threadId,
      threadTitle: this.store.thread(a.threadId)?.title ?? '',
      agent: a.agent,
      title: a.title,
      format: a.format,
      status: a.status ?? 'draft',
      createdAt: a.createdAt,
      shownAt: a.shownAt ?? a.createdAt,
      approvedAt: a.approvedAt ?? null,
      archivedAt: a.archivedAt ?? null,
    };
  }

  private broadcastDoc(id: string): void {
    const a = this.store.artifact(id);
    if (a?.shownAt) this.broadcast({ kind: 'doc', doc: this.docSummary(a) });
  }

  docs(): DocSummary[] {
    return this.store.docs().map((a) => this.docSummary(a));
  }

  doc(id: string): DocResponse | undefined {
    const a = this.store.artifact(id);
    if (!a?.shownAt) return undefined;
    return { ...this.docSummary(a), content: a.content };
  }

  /**
   * The owner approves a doc (or takes it back to draft). The thread shows it, and agents see it
   * when they read the artifact, so the approved version is the one they build on.
   */
  setDocStatus(id: string, status: DocStatus): DocSummary {
    const before = this.store.artifact(id);
    if (!before?.shownAt) throw new Error('No such doc');
    const a = this.store.setDocStatus(id, status, Date.now())!;
    const thread = this.store.thread(a.threadId);
    const root = thread && this.store.session(thread.rootSessionId);
    if (root && before.status !== status) {
      this.emit(root, null, { type: 'status', text: status === 'approved' ? `Owner approved "${a.title}" (artifact ${a.id}).` : `Owner moved "${a.title}" (artifact ${a.id}) back to draft.` });
    }
    // Approving a version settles the drafts before it: they leave the Docs list (still under Archived).
    if (status === 'approved' && before.status !== 'approved') {
      const shownAt = a.shownAt ?? a.createdAt;
      const now = Date.now();
      for (const old of this.store.docs(a.threadId)) {
        if (old.id === a.id || old.archivedAt || (old.status ?? 'draft') !== 'draft' || (old.shownAt ?? old.createdAt) >= shownAt) continue;
        this.store.setDocArchived(old.id, now);
        this.broadcastDoc(old.id);
      }
    }
    const doc = this.docSummary(a);
    this.broadcast({ kind: 'doc', doc });
    this.refreshThread(a.threadId);
    return doc;
  }

  /** The owner archives a doc (or brings it back). Only the Docs list changes; agents can still read it. */
  setDocArchived(id: string, archived: boolean): DocSummary {
    const before = this.store.artifact(id);
    if (!before?.shownAt) throw new Error('No such doc');
    const a = this.store.setDocArchived(id, archived ? (before.archivedAt ?? Date.now()) : null)!;
    const doc = this.docSummary(a);
    this.broadcast({ kind: 'doc', doc });
    return doc;
  }

  private saveMemory(session: SessionRow, agent: LoadedAgent, memory: string, maxEntries: number, text: string): string {
    const entry = text.replace(/\s+/g, ' ').trim();
    if (!entry) throw new Error('The memory entry is empty.');
    const id = newId('m');
    this.store.insertMemory({ id, agent: agent.name, memory, text: entry, threadId: session.threadId, createdAt: Date.now() });
    const all = this.store.memories(agent.name, memory);
    for (const old of all.slice(0, Math.max(0, all.length - maxEntries))) this.store.deleteMemory(old.id);
    this.emit(session, this.running.get(session.id)?.turnId ?? null, { type: 'status', text: `Remembered (${memory}): ${entry}` });
    return `Saved to your ${memory} memory as ${id}. It appears in your instructions from the next turn.`;
  }

  private removeMemory(session: SessionRow, agent: LoadedAgent, memory: string, id: string): string {
    const entry = this.store.memories(agent.name, memory).find((m) => m.id === id.trim());
    if (!entry) throw new Error(`No entry ${id} in your ${memory} memory.`);
    this.store.deleteMemory(entry.id);
    this.emit(session, this.running.get(session.id)?.turnId ?? null, { type: 'status', text: `Forgot (${memory}): ${entry.text}` });
    return `Removed ${entry.id} from your ${memory} memory.`;
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /** After a restart: anything that was running is now interrupted. */
  recover(): number {
    // Approvals were waiting on turns that no longer exist. Draft items are from builds before
    // the Docs tab, where drafts now live.
    for (const item of this.store.openInbox().filter((i) => i.kind === 'approval' || (i.kind === 'draft' && this.store.docsBackfilled))) {
      this.store.resolveInbox(item.id);
    }
    const turns = this.store.turnsWithStatus('running');
    const threads = new Set<string>();
    for (const t of turns) {
      killOrphan(this.store.turnPid(t.id), t.sessionId);
      this.store.finishTurn(t.id, 'interrupted', null, 'Crew was restarted');
      const session = this.store.session(t.sessionId);
      if (!session) continue;
      // The card for this specialist in the caller's chat must not stay on "Working".
      const cardOwner = t.callerSessionId ?? session.parentSessionId;
      if (cardOwner) {
        this.store.insertEvent({
          type: 'subagent_done',
          childSessionId: session.id,
          childTurnId: t.id,
          role: session.role,
          status: 'interrupted',
          result: 'Crew was restarted',
          durationMs: Date.now() - t.startedAt,
          threadId: t.threadId,
          sessionId: cardOwner,
          turnId: null,
          ts: Date.now(),
        });
      }
      this.store.insertEvent({
        type: 'turn_done',
        status: 'interrupted',
        durationMs: Date.now() - t.startedAt,
        error: 'Crew was restarted',
        threadId: t.threadId,
        sessionId: t.sessionId,
        turnId: t.id,
        ts: Date.now(),
      });
      threads.add(t.threadId);
    }
    for (const s of this.store.sessionsWithStatus('running', 'queued')) {
      this.store.updateSession(s.id, { status: 'interrupted' });
      threads.add(s.threadId);
    }
    for (const threadId of threads) {
      const thread = this.store.thread(threadId);
      if (!thread) continue;
      const root = this.store.session(thread.rootSessionId);
      if (root?.status === 'interrupted' && !this.store.openInboxOfThread(threadId, ['interrupted']).length) {
        this.addInbox(root, 'interrupted', `Interrupted: ${thread.title}`, 'Crew restarted while this thread was working. Resume to continue where it left off.');
      }
      this.refreshThread(threadId);
    }
    return turns.length;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const c of this.titleJobs.values()) c.abort();
    const pending = [...this.running.values()];
    for (const r of pending) r.controller.abort('shutdown' satisfies AbortReason);
    await Promise.race([Promise.allSettled(pending.map((r) => r.done)), new Promise((r) => setTimeout(r, 8000))]);
    // Anything still marked running is picked up by recover() on the next start.
  }
}

function docFormat(v: unknown): DocFormat {
  return v === 'html' || v === 'concepts' ? v : 'markdown';
}
