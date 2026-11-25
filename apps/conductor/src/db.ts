// SQLite storage via Node's built-in node:sqlite. Threads, sessions, turns,
// events and inbox items.

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  CrewEvent,
  CrewEventBody,
  DocFormat,
  DocStatus,
  EventBase,
  InboxItem,
  InboxKind,
  Session,
  SessionStatus,
  Thread,
  ThreadStatus,
  Turn,
  TurnStatus,
  Usage,
} from '@crew/protocol';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  benched TEXT NOT NULL DEFAULT '[]',
  allowed_tools TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  role TEXT NOT NULL,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  engine_session_id TEXT,
  engine_session_started INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT,
  depth INTEGER NOT NULL,
  workdir TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_thread ON sessions(thread_id);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  thread_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  caller_session_id TEXT,
  result TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  pid INTEGER
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, id);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_status ON inbox(status);

-- Long work handed between agents by id (save_artifact / read_artifact).
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  format TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_thread ON artifacts(thread_id);

-- Agent memory (agent/memory/<name>.ts), kept across threads.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  memory TEXT NOT NULL,
  text TEXT NOT NULL,
  thread_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_agent ON memories(agent, memory);

-- Owner verdicts for the real-task test (milestone 6), written by \`pnpm crew verdict\`.
CREATE TABLE IF NOT EXISTS verdicts (
  thread_id TEXT PRIMARY KEY,
  quality INTEGER,
  app INTEGER,
  note TEXT,
  ts INTEGER NOT NULL
);
`;

type Row = Record<string, SQLInputValue>;

function toThread(r: Row): Omit<Thread, 'roles' | 'statusText' | 'usage'> {
  return {
    id: r.id as string,
    title: r.title as string,
    status: r.status as ThreadStatus,
    rootSessionId: r.root_session_id as string,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archived: Boolean(r.archived),
    benched: parseList(r.benched),
  };
}

function parseList(v: SQLInputValue | undefined): string[] {
  try {
    const list = JSON.parse(String(v ?? '[]')) as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface SessionRow extends Session {
  engineSessionStarted: boolean;
}

function toSession(r: Row): SessionRow {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    role: r.role as string,
    engine: r.engine as Session['engine'],
    model: r.model as string,
    status: r.status as SessionStatus,
    engineSessionId: (r.engine_session_id as string | null) ?? null,
    engineSessionStarted: Boolean(r.engine_session_started),
    parentSessionId: (r.parent_session_id as string | null) ?? null,
    depth: Number(r.depth),
    workdir: r.workdir as string,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toTurn(r: Row): Turn {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    threadId: r.thread_id as string,
    prompt: r.prompt as string,
    status: r.status as TurnStatus,
    callerSessionId: (r.caller_session_id as string | null) ?? null,
    result: (r.result as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    startedAt: Number(r.started_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    usage:
      r.cost_usd == null && r.input_tokens == null && r.output_tokens == null
        ? null
        : {
            costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
            inputTokens: Number(r.input_tokens ?? 0),
            outputTokens: Number(r.output_tokens ?? 0),
          },
  };
}

function toEvent(r: Row): CrewEvent {
  const body = JSON.parse(r.body as string) as CrewEventBody;
  return {
    ...body,
    id: Number(r.id),
    threadId: r.thread_id as string,
    sessionId: r.session_id as string,
    turnId: (r.turn_id as string | null) ?? null,
    ts: Number(r.ts),
  } as CrewEvent;
}

function toInbox(r: Row): InboxItem {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    sessionId: r.session_id as string,
    kind: r.kind as InboxKind,
    role: (r.role as string | null) ?? '',
    previewId: (r.preview_id as string | null) ?? undefined,
    ...(r.choices ? (JSON.parse(r.choices as string) as Pick<InboxItem, 'options' | 'recommended' | 'multiSelect'>) : {}),
    title: r.title as string,
    body: r.body as string,
    status: r.status as InboxItem['status'],
    createdAt: Number(r.created_at),
  };
}

export interface ArtifactRow {
  id: string;
  threadId: string;
  sessionId: string;
  agent: string;
  title: string;
  format: DocFormat;
  content: string;
  createdAt: number;
  status?: DocStatus;
  /** Set once the owner has seen it in the preview: it is then a doc in the Docs tab. */
  shownAt?: number | null;
  approvedAt?: number | null;
  archivedAt?: number | null;
}

export interface MemoryRow {
  id: string;
  agent: string;
  memory: string;
  text: string;
  threadId: string | null;
  createdAt: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    // Small forward-only migrations for databases created by earlier builds.
    for (const sql of [
      'ALTER TABLE turns ADD COLUMN pid INTEGER',
      "ALTER TABLE inbox ADD COLUMN role TEXT NOT NULL DEFAULT ''",
      'ALTER TABLE inbox ADD COLUMN preview_id TEXT',
      'ALTER TABLE inbox ADD COLUMN choices TEXT',
      "ALTER TABLE threads ADD COLUMN benched TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE threads ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE turns ADD COLUMN cost_usd REAL',
    'ALTER TABLE turns ADD COLUMN input_tokens INTEGER',
    'ALTER TABLE turns ADD COLUMN output_tokens INTEGER',
    "ALTER TABLE artifacts ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'",
    'ALTER TABLE artifacts ADD COLUMN approved_at INTEGER',
    'ALTER TABLE artifacts ADD COLUMN archived_at INTEGER',
    ]) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists.
      }
    }
    try {
      this.db.exec('ALTER TABLE artifacts ADD COLUMN shown_at INTEGER');
    } catch {
      // Column already exists.
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS artifacts_shown ON artifacts(thread_id, shown_at)');
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, done_at INTEGER NOT NULL)');
    this.docsBackfilled = this.runOnce('docs-backfill', () => this.backfillShownDocs());
  }

  /** False while the Docs backfill has not completed: legacy draft Inbox items must stay. */
  readonly docsBackfilled: boolean;

  /**
   * Runs a data migration once, in one transaction, and records it only when it completed.
   * A failure rolls back and is retried on the next start.
   */
  private runOnce(name: string, fn: () => void): boolean {
    if (this.get('SELECT 1 FROM migrations WHERE name = ?', name)) return true;
    try {
      this.db.exec('BEGIN');
      fn();
      this.run('INSERT INTO migrations (name, done_at) VALUES (?, ?)', name, Date.now());
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // No transaction left to roll back.
      }
      console.error(`Migration ${name} failed; it runs again on the next start.`, err);
      return false;
    }
  }

  /**
   * For databases from before the Docs tab: every preview the owner was shown becomes a doc.
   * A preview links to an existing artifact only when exactly one artifact in its thread, made
   * before it, has the same content; otherwise it gets its own snapshot keyed by the event.
   */
  private backfillShownDocs(): void {
    const previews = this.all("SELECT e.id, e.thread_id, e.session_id, e.ts, e.body, s.role FROM events e LEFT JOIN sessions s ON s.id = e.session_id WHERE e.type = 'preview' ORDER BY e.id");
    for (const p of previews) {
      let body: { previewId?: string; title?: string; format?: DocFormat; content?: string; artifactId?: string };
      try {
        body = JSON.parse(String(p.body)) as typeof body;
      } catch {
        continue;
      }
      if (!body.content) continue;
      const threadId = p.thread_id as string;
      const ts = Number(p.ts);
      let artifactId: string | undefined;
      // Already linked (a build that recorded it): keep it when it really is in this thread.
      if (body.artifactId && this.get('SELECT 1 FROM artifacts WHERE id = ? AND thread_id = ?', body.artifactId, threadId)) {
        artifactId = body.artifactId;
      } else {
        // Only artifacts agents saved: never a snapshot this backfill made for another preview.
        const matches = this.all(
          "SELECT id FROM artifacts WHERE thread_id = ? AND content = ? AND created_at <= ? AND id NOT LIKE 'a-e%' LIMIT 2",
          threadId,
          body.content,
          ts,
        );
        if (matches.length === 1) artifactId = matches[0]!.id as string;
      }
      if (!artifactId) {
        // "a-": agents' artifacts are always "a_<random>", so a snapshot id can never clash.
        artifactId = `a-e${String(p.id)}`;
        this.run(
          'INSERT OR IGNORE INTO artifacts (id, thread_id, session_id, agent, title, format, content, created_at) VALUES (?,?,?,?,?,?,?,?)',
          artifactId,
          threadId,
          p.session_id as string,
          String(p.role ?? ''),
          body.title || 'Preview',
          body.format ?? 'markdown',
          body.content,
          ts,
        );
      }
      this.run('UPDATE artifacts SET shown_at = MAX(COALESCE(shown_at, 0), ?) WHERE id = ?', ts, artifactId);
      // The app links a preview to its doc by this id.
      if (body.artifactId !== artifactId) this.run('UPDATE events SET body = ? WHERE id = ?', JSON.stringify({ ...body, artifactId }), Number(p.id));
    }
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  // Threads ------------------------------------------------------------------

  insertThread(t: Omit<Thread, 'roles' | 'statusText' | 'usage'>): void {
    this.run(
      'INSERT INTO threads (id, title, status, root_session_id, created_at, updated_at, archived, benched) VALUES (?,?,?,?,?,?,?,?)',
      t.id, t.title, t.status, t.rootSessionId, t.createdAt, t.updatedAt, t.archived ? 1 : 0, JSON.stringify(t.benched),
    );
  }
  thread(id: string): Omit<Thread, 'roles' | 'statusText' | 'usage'> | undefined {
    const r = this.get('SELECT * FROM threads WHERE id = ?', id);
    return r && toThread(r);
  }
  threads(): Omit<Thread, 'roles' | 'statusText' | 'usage'>[] {
    return this.all('SELECT * FROM threads ORDER BY updated_at DESC').map(toThread);
  }
  setThreadTitle(id: string, title: string): Omit<Thread, 'roles' | 'statusText' | 'usage'> {
    const t = this.thread(id);
    if (!t) throw new Error(`No thread ${id}`);
    this.run('UPDATE threads SET title = ? WHERE id = ?', title, id);
    return { ...t, title };
  }
  updateThread(id: string, patch: Partial<Pick<Thread, 'title' | 'status' | 'archived'>>): Omit<Thread, 'roles' | 'statusText' | 'usage'> {
    const t = this.thread(id);
    if (!t) throw new Error(`No thread ${id}`);
    const next = { ...t, ...patch, updatedAt: Date.now() };
    this.run(
      'UPDATE threads SET title = ?, status = ?, archived = ?, updated_at = ? WHERE id = ?',
      next.title, next.status, next.archived ? 1 : 0, next.updatedAt, id,
    );
    return next;
  }

  /** Tools the owner allowed for the rest of this thread, as `agent:tool`; `*` is every tool. */
  allowedTools(threadId: string): string[] {
    return parseList(this.get('SELECT allowed_tools FROM threads WHERE id = ?', threadId)?.allowed_tools);
  }
  allowTool(threadId: string, key: string): void {
    const list = this.allowedTools(threadId);
    if (list.includes(key)) return;
    this.run('UPDATE threads SET allowed_tools = ? WHERE id = ?', JSON.stringify([...list, key]), threadId);
  }

  // Sessions -----------------------------------------------------------------

  insertSession(s: SessionRow): void {
    this.run(
      `INSERT INTO sessions (id, thread_id, role, engine, model, status, engine_session_id, engine_session_started,
        parent_session_id, depth, workdir, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.id, s.threadId, s.role, s.engine, s.model, s.status, s.engineSessionId, s.engineSessionStarted ? 1 : 0,
      s.parentSessionId, s.depth, s.workdir, s.createdAt, s.updatedAt,
    );
  }
  session(id: string): SessionRow | undefined {
    const r = this.get('SELECT * FROM sessions WHERE id = ?', id);
    return r && toSession(r);
  }
  sessionsOfThread(threadId: string): SessionRow[] {
    return this.all('SELECT * FROM sessions WHERE thread_id = ? ORDER BY created_at', threadId).map(toSession);
  }
  sessionsWithStatus(...statuses: SessionStatus[]): SessionRow[] {
    return this.all(
      `SELECT * FROM sessions WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY updated_at DESC`,
      ...statuses,
    ).map(toSession);
  }
  updateSession(
    id: string,
    patch: Partial<Pick<SessionRow, 'status' | 'engineSessionId' | 'engineSessionStarted' | 'model'>>,
  ): SessionRow {
    const s = this.session(id);
    if (!s) throw new Error(`No session ${id}`);
    const next = { ...s, ...patch, updatedAt: Date.now() };
    this.run(
      'UPDATE sessions SET status = ?, engine_session_id = ?, engine_session_started = ?, model = ?, updated_at = ? WHERE id = ?',
      next.status, next.engineSessionId, next.engineSessionStarted ? 1 : 0, next.model, next.updatedAt, id,
    );
    return next;
  }

  // Turns --------------------------------------------------------------------

  insertTurn(t: Turn): void {
    this.run(
      `INSERT INTO turns (id, session_id, thread_id, prompt, status, caller_session_id, result, error, started_at, ended_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      t.id, t.sessionId, t.threadId, t.prompt, t.status, t.callerSessionId, t.result, t.error, t.startedAt, t.endedAt,
    );
  }
  turn(id: string): Turn | undefined {
    const r = this.get('SELECT * FROM turns WHERE id = ?', id);
    return r && toTurn(r);
  }
  turnsOfThread(threadId: string): Turn[] {
    return this.all('SELECT * FROM turns WHERE thread_id = ? ORDER BY started_at', threadId).map(toTurn);
  }
  turnsWithStatus(status: TurnStatus): Turn[] {
    return this.all('SELECT * FROM turns WHERE status = ?', status).map(toTurn);
  }
  lastTurnOfSession(sessionId: string): Turn | undefined {
    const r = this.get('SELECT * FROM turns WHERE session_id = ? ORDER BY started_at DESC LIMIT 1', sessionId);
    return r && toTurn(r);
  }
  setTurnPid(id: string, pid: number): void {
    this.run('UPDATE turns SET pid = ? WHERE id = ?', pid, id);
  }
  turnPid(id: string): number | null {
    const r = this.get('SELECT pid FROM turns WHERE id = ?', id);
    return r?.pid == null ? null : Number(r.pid);
  }
  finishTurn(id: string, status: TurnStatus, result: string | null, error: string | null, usage?: Usage): Turn {
    this.run(
      'UPDATE turns SET status = ?, result = ?, error = ?, ended_at = ?, cost_usd = ?, input_tokens = ?, output_tokens = ? WHERE id = ?',
      status, result, error, Date.now(), usage?.costUsd ?? null, usage?.inputTokens ?? null, usage?.outputTokens ?? null, id,
    );
    return this.turn(id)!;
  }
  /** Everything the thread's turns used, all agents together. */
  usageOfThread(threadId: string): Usage {
    const r = this.get(
      `SELECT SUM(cost_usd) AS cost, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
        SUM(CASE WHEN cost_usd IS NULL THEN COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) ELSE 0 END) AS unpriced
       FROM turns WHERE thread_id = ?`,
      threadId,
    );
    return {
      costUsd: r?.cost == null ? null : Number(r.cost),
      inputTokens: Number(r?.input ?? 0),
      outputTokens: Number(r?.output ?? 0),
      unpricedTokens: Number(r?.unpriced ?? 0),
    };
  }

  // Events -------------------------------------------------------------------

  insertEvent(e: CrewEventBody & Omit<EventBase, 'id'>): CrewEvent {
    const { threadId, sessionId, turnId, ts, ...body } = e;
    const res = this.db
      .prepare('INSERT INTO events (thread_id, session_id, turn_id, type, body, ts) VALUES (?,?,?,?,?,?)')
      .run(threadId, sessionId, turnId, body.type, JSON.stringify(body), ts);
    return { ...e, id: Number(res.lastInsertRowid) } as CrewEvent;
  }
  eventsOfThread(threadId: string): CrewEvent[] {
    return this.all('SELECT * FROM events WHERE thread_id = ? ORDER BY id', threadId).map(toEvent);
  }
  lastEventOfSession(sessionId: string, types: string[]): CrewEvent | undefined {
    const r = this.get(
      `SELECT * FROM events WHERE session_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`,
      sessionId, ...types,
    );
    return r && toEvent(r);
  }

  // Inbox --------------------------------------------------------------------

  insertInbox(i: InboxItem): void {
    this.run(
      'INSERT INTO inbox (id, thread_id, session_id, kind, role, preview_id, choices, title, body, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      i.id, i.threadId, i.sessionId, i.kind, i.role, i.previewId ?? null,
      i.options?.length ? JSON.stringify({ options: i.options, recommended: i.recommended, multiSelect: i.multiSelect }) : null,
      i.title, i.body, i.status, i.createdAt,
    );
  }
  inboxItem(id: string): InboxItem | undefined {
    const r = this.get('SELECT * FROM inbox WHERE id = ?', id);
    return r && toInbox(r);
  }
  openInbox(): InboxItem[] {
    return this.all("SELECT * FROM inbox WHERE status = 'open' ORDER BY created_at DESC").map(toInbox);
  }
  openInboxOfThread(threadId: string, kinds?: InboxKind[]): InboxItem[] {
    const rows = this.all("SELECT * FROM inbox WHERE status = 'open' AND thread_id = ? ORDER BY created_at", threadId).map(toInbox);
    return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  }
  reopenInbox(id: string): InboxItem | undefined {
    this.run("UPDATE inbox SET status = 'open' WHERE id = ?", id);
    return this.inboxItem(id);
  }
  resolveInbox(id: string): InboxItem | undefined {
    this.run("UPDATE inbox SET status = 'resolved' WHERE id = ?", id);
    return this.inboxItem(id);
  }

  // Artifacts ----------------------------------------------------------------

  insertArtifact(a: ArtifactRow): void {
    this.run(
      'INSERT INTO artifacts (id, thread_id, session_id, agent, title, format, content, created_at) VALUES (?,?,?,?,?,?,?,?)',
      a.id, a.threadId, a.sessionId, a.agent, a.title, a.format, a.content, a.createdAt,
    );
  }
  artifact(id: string): ArtifactRow | undefined {
    const r = this.get('SELECT * FROM artifacts WHERE id = ?', id);
    return r && toArtifact(r);
  }
  /** Docs: artifacts the owner has been shown, newest first. Without content. */
  docs(threadId?: string): Array<Omit<ArtifactRow, 'content'>> {
    const cols = "id, thread_id, session_id, agent, title, format, '' AS content, created_at, status, shown_at, approved_at, archived_at";
    return (
      threadId
        ? this.all(`SELECT ${cols} FROM artifacts WHERE shown_at IS NOT NULL AND thread_id = ? ORDER BY shown_at DESC`, threadId)
        : this.all(`SELECT ${cols} FROM artifacts WHERE shown_at IS NOT NULL ORDER BY shown_at DESC`)
    ).map(toArtifact);
  }
  /** Status of the doc the owner was shown last in a thread, if any. */
  latestDocStatusOfThread(threadId: string): DocStatus | undefined {
    const r = this.get('SELECT status FROM artifacts WHERE thread_id = ? AND shown_at IS NOT NULL ORDER BY shown_at DESC LIMIT 1', threadId);
    return r ? (r.status as DocStatus) : undefined;
  }
  /**
   * Marks a doc as shown now. Within a thread, shown_at strictly increases, so the doc shown
   * last is the latest even when two are shown in the same millisecond.
   */
  markShown(id: string, at: number): void {
    this.run(
      'UPDATE artifacts SET shown_at = MAX(?, (SELECT COALESCE(MAX(a.shown_at), 0) + 1 FROM artifacts a WHERE a.thread_id = artifacts.thread_id)) WHERE id = ?',
      at,
      id,
    );
  }
  setDocStatus(id: string, status: DocStatus, at: number): ArtifactRow | undefined {
    this.run('UPDATE artifacts SET status = ?, approved_at = ? WHERE id = ?', status, status === 'approved' ? at : null, id);
    return this.artifact(id);
  }
  setDocArchived(id: string, archivedAt: number | null): ArtifactRow | undefined {
    this.run('UPDATE artifacts SET archived_at = ? WHERE id = ?', archivedAt, id);
    return this.artifact(id);
  }


  // Memory -------------------------------------------------------------------

  memories(agent: string, memory: string): MemoryRow[] {
    return this.all('SELECT * FROM memories WHERE agent = ? AND memory = ? ORDER BY created_at', agent, memory).map((r) => ({
      id: r.id as string,
      agent: r.agent as string,
      memory: r.memory as string,
      text: r.text as string,
      threadId: (r.thread_id as string | null) ?? null,
      createdAt: Number(r.created_at),
    }));
  }
  insertMemory(m: MemoryRow): void {
    this.run(
      'INSERT INTO memories (id, agent, memory, text, thread_id, created_at) VALUES (?,?,?,?,?,?)',
      m.id, m.agent, m.memory, m.text, m.threadId, m.createdAt,
    );
  }
  deleteMemory(id: string): void {
    this.run('DELETE FROM memories WHERE id = ?', id);
  }
}

function toArtifact(r: Row): ArtifactRow {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    sessionId: r.session_id as string,
    agent: r.agent as string,
    title: r.title as string,
    format: r.format as ArtifactRow['format'],
    content: r.content as string,
    createdAt: Number(r.created_at),
    status: (r.status as DocStatus | undefined) ?? 'draft',
    shownAt: r.shown_at == null ? null : Number(r.shown_at),
    approvedAt: r.approved_at == null ? null : Number(r.approved_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
  };
}
