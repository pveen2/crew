// The heart of the conductor. Threads own a root session (the lead, agent/);
// sessions run turns on their engine; the lead's subagent tools start or
// reuse a specialist's session in the same thread and wait for its answer.
// Specialists do not delegate further (one level, like eve).

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type {
  AgentActivity,
  Attachment,
  AttachmentUpload,
  CrewEvent,
  CrewEventBody,
  InboxItem,
  InboxKind,
  RoleSummary,
  ServerMessage,
  StateResponse,
  Thread,
  ThreadDetailResponse,
  ThreadStatus,
  TurnStatus,
} from '@crew/protocol';
import { loadCrew, subagentToolName, type LoadedAgent, type LoadedCrew } from '@crew/sdk/load';
import { REAL_HOME, denyPaths, nodeChildEnv, paths, port, steeringEnabled } from './config.ts';
import type { SessionRow, Store } from './db.ts';
import { engines, type EngineEvent, type McpServerSpec, type Steer } from './engines/index.ts';
import { translateAgent, type MemoryRecall } from './translate.ts';

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
}

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
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
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(src)) {
    const to = join(dest, f);
    if (existsSync(to)) continue;
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

function snippet(text: string, max = 120): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export class Runtime {
  private readonly running = new Map<string, RunningTurn>();
  /** Owner messages still waiting for their turn, by message event id. */
  private readonly queuedMessages = new Map<number, QueuedMessage>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Turns waiting to start, per session. */
  private readonly pending = new Map<string, number>();
  /** Bumped by Stop; queued turns from an older generation are skipped. */
  private readonly stopGen = new Map<string, number>();
  private readonly bridgeSecret = randomBytes(32);
  /** Tool calls waiting for the owner's approve or deny, by Inbox item id. */
  private readonly approvals = new Map<string, (approved: boolean) => void>();
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

  private addInbox(session: SessionRow, kind: InboxKind, title: string, body: string, previewId?: string): InboxItem {
    const item: InboxItem = {
      id: newId('i'),
      threadId: session.threadId,
      sessionId: session.id,
      kind,
      role: session.role,
      previewId,
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
    const waiter = this.approvals.get(id);
    if (waiter) {
      this.approvals.delete(id);
      waiter(false);
    }
    const item = this.store.resolveInbox(id);
    if (item) {
      this.broadcast({ kind: 'inbox', item });
      this.refreshThread(item.threadId);
    }
    return item;
  }

  private resolveInboxOf(threadId: string, kinds: InboxKind[], sessionId?: string): void {
    for (const item of this.store.openInboxOfThread(threadId, kinds)) {
      if (!sessionId || item.sessionId === sessionId) this.resolveInbox(item.id);
    }
  }

  // -------------------------------------------------------------------------
  // Read models

  private withMeta(t: Omit<Thread, 'roles' | 'statusText'>): Thread {
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
      const open = this.store.openInboxOfThread(t.id, ['draft']);
      statusText = open.length ? 'Draft to review' : 'Done';
    }
    return { ...t, roles, statusText };
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
      team: { name: crew.config.name, suggestions: crew.config.suggestions ?? [] },
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
    return saved;
  }

  sendMessage(threadId: string, text: string, sessionId?: string, replyTo?: string, uploads?: AttachmentUpload[]): { sessionId: string } {
    const thread = this.store.thread(threadId);
    if (!thread) throw new Error(`No thread ${threadId}`);
    if (thread.archived) throw new Error('This thread is closed.');
    const session = this.store.session(sessionId ?? thread.rootSessionId);
    if (!session || session.threadId !== threadId) throw new Error('That session is not part of this thread');

    let answered = false;
    if (replyTo) {
      // An answer to one question resolves that question only.
      const item = this.store.inboxItem(replyTo);
      if (!item || item.sessionId !== session.id || item.kind !== 'needs_you') {
        throw new Error('That question does not belong to this agent.');
      }
      if (item.status === 'open') this.resolveInbox(item.id);
      answered = true;
    } else if (this.store.openInboxOfThread(threadId, ['needs_you']).filter((i) => i.sessionId === session.id).length === 1) {
      // A plain reply while exactly one question is open answers that question.
      this.resolveInboxOf(threadId, ['needs_you'], session.id);
      answered = true;
    }
    if (session.depth === 0) this.resolveInboxOf(threadId, ['error']);

    const attachments = saveAttachments(threadId, uploads);
    text = text.trim() || (attachments.length ? 'See the attached image.' : text);
    const promptOf = (t: string) => (session.depth === 0 ? t : `Message from the owner, who stepped into your work:\n\n${t}`) + attachmentNote(attachments);
    const prompt = promptOf(text);
    const images = attachments.map((a) => a.file);
    const message = { type: 'message', role: 'user', text, from: 'owner', ...(attachments.length ? { attachments } : {}) } as const;

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
      ? { eventId: event.id, sessionId: session.id, prompt: promptOf, text, removed: false }
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
    this.emit(this.store.session(q.sessionId)!, null, { type: 'message_delivery', messageId: eventId, state: 'removed' });
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
        callerSessionId: null, result: null, error: NOT_STARTED, startedAt: now, endedAt: now,
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

    this.store.finishTurn(turnId, outcome.status, outcome.text || null, outcome.error ?? null);
    this.running.delete(sessionId);
    const queued = (this.pending.get(sessionId) ?? 0) > 0;
    const sessionStatus =
      outcome.status === 'interrupted' ? 'interrupted' : outcome.status === 'error' ? 'error' : queued ? 'queued' : 'idle';
    session = this.setSession(sessionId, { status: sessionStatus });
    this.emit(session, turnId, { type: 'turn_done', status: outcome.status, durationMs: Date.now() - startedAt, error: outcome.error });

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
  attachmentFile(threadId: string, file: string): { mime: string; data: Buffer } | undefined {
    if (!/^[\w-]+$/.test(threadId) || !/^[\w.-]+$/.test(file) || file.startsWith('.')) return undefined;
    const p = join(paths.attachments, threadId, file);
    if (!existsSync(p)) return undefined;
    const ext = file.split('.').pop() ?? '';
    const mime = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
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
      case 'ask_owner':
        return this.askOwner(session, String(args.question ?? ''));
      case 'show_preview':
        return this.showPreview(session, agent, args);
      case 'save_artifact':
        if (agent.isLead) throw new Error('The lead hands work back; specialists save artifacts.');
        return this.saveArtifact(session, agent, args);
      case 'read_artifact':
        return this.readArtifact(session, String(args.id ?? ''));
      default:
        throw new Error(`Unknown tool ${tool}`);
    }
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
      this.approvals.set(item.id, resolve);
      if (signal.aborted) resolve(false);
      else signal.addEventListener('abort', () => resolve(false), { once: true });
    });
    if (this.approvals.get(item.id)) this.approvals.delete(item.id);
    if (this.store.inboxItem(item.id)?.status === 'open') this.resolveInbox(item.id);
    this.emit(session, turnId, { type: 'approval_done', inboxId: item.id, toolName, approved });
    this.refreshThread(session.threadId);
    if (!approved) {
      throw new Error(`The owner denied ${toolName}. Do not try again another way; carry on without it or explain what is blocked.`);
    }
  }

  /** The owner's decision on an approval item. */
  decideApproval(inboxId: string, approved: boolean): InboxItem {
    const item = this.store.inboxItem(inboxId);
    if (!item || item.kind !== 'approval') throw new Error('No such approval');
    const waiter = this.approvals.get(inboxId);
    if (!waiter) {
      if (item.status === 'open') this.resolveInbox(inboxId);
      throw new Error('This approval is no longer waiting: the turn that asked for it has ended.');
    }
    this.approvals.delete(inboxId);
    waiter(approved);
    return this.resolveInbox(inboxId) ?? item;
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

  private askOwner(session: SessionRow, question: string): string {
    const item = this.addInbox(session, 'needs_you', question.split('\n')[0]!.slice(0, 140), question);
    this.emit(session, this.running.get(session.id)?.turnId ?? null, { type: 'needs_you', question, inboxId: item.id });
    this.refreshThread(session.threadId);
    return "Your question is in the owner's Inbox. End your turn now with a one-line summary; their answer will arrive as a new message.";
  }

  private showPreview(session: SessionRow, agent: LoadedAgent, args: Record<string, unknown>): string {
    let title = typeof args.title === 'string' ? args.title.trim() : '';
    let content = typeof args.content === 'string' ? args.content : '';
    let format: 'markdown' | 'html' = args.format === 'html' ? 'html' : 'markdown';
    const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : '';
    if (artifactId) {
      const a = this.store.artifact(artifactId);
      if (!a || a.threadId !== session.threadId) throw new Error(`No artifact ${artifactId} in this thread.`);
      content = a.content;
      format = a.format;
      title ||= a.title;
    }
    if (!content.trim()) throw new Error('Pass an artifactId, or content to show.');
    title ||= 'Preview';

    const previewId = newId('p');
    this.emit(session, this.running.get(session.id)?.turnId ?? null, { type: 'preview', previewId, title, format, content });
    // Only the thread owner's previews go to the Inbox; specialists' drafts usually feed into it.
    if (session.depth === 0) this.addInbox(session, 'draft', `Draft ready: ${title}`, `${agent.label} put "${title}" in the preview panel.`, previewId);
    return `Shown to the owner in the preview panel as "${title}".`;
  }

  private saveArtifact(session: SessionRow, agent: LoadedAgent, args: Record<string, unknown>): string {
    const title = String(args.title ?? '').trim();
    const content = String(args.content ?? '');
    if (!title || !content.trim()) throw new Error('An artifact needs a title and content.');
    if (content.length > 200_000) throw new Error('Artifacts are capped at 200,000 characters. Split the work or shorten it.');
    const id = newId('a');
    this.store.insertArtifact({
      id,
      threadId: session.threadId,
      sessionId: session.id,
      agent: agent.name,
      title,
      format: args.format === 'html' ? 'html' : 'markdown',
      content,
      createdAt: Date.now(),
    });
    this.emit(session, this.running.get(session.id)?.turnId ?? null, { type: 'status', text: `Saved artifact ${id}: ${title}` });
    return `Saved as artifact ${id} ("${title}", ${content.length} characters). Return this id with a short summary; do not paste the content.`;
  }

  private readArtifact(session: SessionRow, id: string): string {
    const a = this.store.artifact(id.trim());
    if (!a || a.threadId !== session.threadId) throw new Error(`No artifact ${id} in this thread.`);
    return `# ${a.title}\n\n(artifact ${a.id} by ${a.agent}, ${a.format})\n\n${a.content}`;
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
    // Approvals were waiting on turns that no longer exist.
    for (const item of this.store.openInbox().filter((i) => i.kind === 'approval')) this.store.resolveInbox(item.id);
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
    const pending = [...this.running.values()];
    for (const r of pending) r.controller.abort('shutdown' satisfies AbortReason);
    await Promise.race([Promise.allSettled(pending.map((r) => r.done)), new Promise((r) => setTimeout(r, 8000))]);
    // Anything still marked running is picked up by recover() on the next start.
  }
}
