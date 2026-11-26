// SQLite storage via Node's built-in node:sqlite. Threads, sessions, turns,
// events and inbox items.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  Attachment,
  CrewEvent,
  Dm,
  DmMessage,
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
  SpendDay,
  SpendResponse,
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

-- Team server: who is in which thread (started it, wrote in it, was tagged),
-- and everyone who has signed in.
CREATE TABLE IF NOT EXISTS thread_people (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  email TEXT NOT NULL,
  PRIMARY KEY (thread_id, email)
);
CREATE TABLE IF NOT EXISTS people (
  email TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- Read-only share links (team server): one per thread, a snapshot taken when
-- shared or updated. Stopping sharing deletes the row, so the link stops working.
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id),
  snapshot TEXT NOT NULL,
  shared_at INTEGER NOT NULL,
  shared_by TEXT
);

-- Direct messages (team server): plain chats between people, apart from threads.
-- No agent takes part. key is the sorted, comma-joined emails: one DM per group.
CREATE TABLE IF NOT EXISTS dms (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_people (
  dm_id TEXT NOT NULL REFERENCES dms(id),
  email TEXT NOT NULL,
  PRIMARY KEY (dm_id, email)
);
CREATE INDEX IF NOT EXISTS dm_people_email ON dm_people(email);
CREATE TABLE IF NOT EXISTS dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dm_id TEXT NOT NULL REFERENCES dms(id),
  by_email TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments TEXT,
  ts INTEGER NOT NULL,
  -- Set by the app per message: a send that is retried after a lost answer lands once.
  client_id TEXT
);
CREATE INDEX IF NOT EXISTS dm_messages_dm ON dm_messages(dm_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS dm_messages_client ON dm_messages(dm_id, by_email, client_id);
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
    createdBy: (r.created_by as string | null) ?? null,
  };
}

function toDmMessage(r: Row): DmMessage {
  const attachments = r.attachments ? (JSON.parse(r.attachments as string) as Attachment[]) : [];
  return {
    id: Number(r.id),
    dmId: r.dm_id as string,
    by: r.by_email as string,
    text: r.text as string,
    ...(attachments.length ? { attachments } : {}),
    ts: Number(r.ts),
  };
}

/** An email as DMs take it: no spaces or commas (a DM's key joins emails with commas). */
export function isEmail(e: string): boolean {
  return /^[^@\s,]+@[^@\s,]+$/.test(e);
}

/** The key of a DM between these people: sorted, lower-case emails. */
export function dmKey(emails: string[]): string {
  return [...new Set(emails.map((e) => e.toLowerCase()))].sort().join(',');
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
    url: (r.url as string | null) ?? undefined,
    ...(r.choices ? (JSON.parse(r.choices as string) as Pick<InboxItem, 'options' | 'recommended' | 'multiSelect' | 'askEveryTime'>) : {}),
    title: r.title as string,
    body: r.body as string,
    status: r.status as InboxItem['status'],
    createdAt: Number(r.created_at),
    ...(r.for_email ? { for: r.for_email as string } : {}),
    ...(r.by_email ? { by: r.by_email as string } : {}),
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

  /** Where attached images live (one folder per thread or DM); for moving old DMs' images. */
  private readonly attachmentsDir: string | undefined;

  constructor(file: string, opts: { attachments?: string } = {}) {
    this.attachmentsDir = opts.attachments;
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    // Small forward-only migrations for databases created by earlier builds.
    for (const sql of [
      'ALTER TABLE turns ADD COLUMN pid INTEGER',
      "ALTER TABLE inbox ADD COLUMN role TEXT NOT NULL DEFAULT ''",
      'ALTER TABLE inbox ADD COLUMN preview_id TEXT',
      'ALTER TABLE inbox ADD COLUMN choices TEXT',
      'ALTER TABLE inbox ADD COLUMN url TEXT',
      "ALTER TABLE threads ADD COLUMN benched TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE threads ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE turns ADD COLUMN cost_usd REAL',
    'ALTER TABLE turns ADD COLUMN input_tokens INTEGER',
    'ALTER TABLE turns ADD COLUMN output_tokens INTEGER',
    "ALTER TABLE artifacts ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'",
    'ALTER TABLE artifacts ADD COLUMN approved_at INTEGER',
    'ALTER TABLE artifacts ADD COLUMN archived_at INTEGER',
    'ALTER TABLE threads ADD COLUMN created_by TEXT',
    'ALTER TABLE inbox ADD COLUMN for_email TEXT',
    'ALTER TABLE threads ADD COLUMN dm INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE inbox ADD COLUMN by_email TEXT',
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
    this.dmsReady = this.runOnce('dms-out-of-threads', () => this.moveDmThreads());
  }

  /** False while old DM threads have not moved to the DM tables: no new DMs until they have. */
  readonly dmsReady: boolean;

  /**
   * DMs used to be threads with an agent waiting in them (threads.dm = 1). Their
   * people's messages move to new DMs with ids of their own (old DM threads with the
   * same people become one), their images are copied along, and the threads stay,
   * hidden: nobody can open them or anything in them again.
   */
  private moveDmThreads(): void {
    const groups = new Map<string, { people: string[]; createdAt: number; threads: string[] }>();
    for (const t of this.all('SELECT id, created_at FROM threads WHERE dm = 1 ORDER BY created_at')) {
      const people = this.peopleOfThread(t.id as string);
      if (people.length < 2 || people.some((e) => !isEmail(e))) continue;
      const key = dmKey(people);
      const g = groups.get(key) ?? { people, createdAt: Number(t.created_at), threads: [] };
      g.threads.push(t.id as string);
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      const dmId = `d_${randomBytes(6).toString('base64url')}`;
      const messages: Array<Omit<DmMessage, 'id' | 'dmId'> & { from: string }> = [];
      for (const threadId of g.threads) {
        const removed = new Set<number>();
        const edited = new Map<number, string>();
        for (const e of this.all("SELECT * FROM events WHERE thread_id = ? AND type = 'message_delivery' ORDER BY id", threadId).map(toEvent)) {
          if (e.type !== 'message_delivery') continue;
          if (e.state === 'removed') removed.add(e.messageId);
          if (e.state === 'edited' && e.text !== undefined) edited.set(e.messageId, e.text);
        }
        for (const e of this.all("SELECT * FROM events WHERE thread_id = ? AND type = 'message' ORDER BY id", threadId).map(toEvent)) {
          // People only: whatever an agent said in an old DM stays out, and so do taken-back messages.
          if (e.type !== 'message' || e.role !== 'user' || !e.by || removed.has(e.id)) continue;
          messages.push({ from: threadId, by: e.by, text: edited.get(e.id) ?? e.text, ...(e.attachments?.length ? { attachments: e.attachments } : {}), ts: e.ts });
        }
      }
      // Two old DMs merged: their messages in the order they were written.
      messages.sort((a, b) => a.ts - b.ts);
      const updatedAt = Math.max(g.createdAt, ...messages.map((m) => m.ts));
      this.run('INSERT INTO dms (id, key, created_at, updated_at) VALUES (?,?,?,?)', dmId, key, g.createdAt, updatedAt);
      for (const e of g.people) this.run('INSERT OR IGNORE INTO dm_people (dm_id, email) VALUES (?, ?)', dmId, e);
      for (const m of messages) {
        // Only the images of messages that moved are copied to the DM's folder.
        const attachments = (m.attachments ?? []).filter((a) => this.copyAttachment(m.from, dmId, a.file));
        this.run(
          'INSERT INTO dm_messages (dm_id, by_email, text, attachments, ts) VALUES (?,?,?,?,?)',
          dmId, m.by, m.text, attachments.length ? JSON.stringify(attachments) : null, m.ts,
        );
      }
    }
  }

  private copyAttachment(fromId: string, toId: string, file: string): boolean {
    if (!this.attachmentsDir || !/^[\w.-]+$/.test(file) || file.startsWith('.')) return false;
    const from = join(this.attachmentsDir, fromId, file);
    if (!existsSync(from)) return false;
    mkdirSync(join(this.attachmentsDir, toId), { recursive: true, mode: 0o700 });
    copyFileSync(from, join(this.attachmentsDir, toId, file));
    return true;
  }

  /** False while the Docs backfill has not completed: legacy draft Inbox items must stay. */
  readonly docsBackfilled: boolean;

  /** Runs fn in one transaction: all of its writes land, or none. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // No transaction left to roll back.
      }
      throw err;
    }
  }

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

  // Share links --------------------------------------------------------------

  shareOfThread(threadId: string): { token: string; sharedAt: number } | undefined {
    const r = this.get('SELECT token, shared_at FROM shares WHERE thread_id = ?', threadId);
    return r && { token: r.token as string, sharedAt: Number(r.shared_at) };
  }
  /** The snapshot behind a link, or undefined when there is no such link (any more). */
  shareByToken(token: string): { threadId: string; snapshot: string } | undefined {
    const r = this.get('SELECT thread_id, snapshot FROM shares WHERE token = ?', token);
    return r && { threadId: r.thread_id as string, snapshot: r.snapshot as string };
  }
  /** Creates the thread's link, or takes a new snapshot for the link it has (same token). */
  saveShare(threadId: string, newToken: string, snapshot: string, sharedAt: number, sharedBy: string | null): string {
    const token = this.shareOfThread(threadId)?.token ?? newToken;
    this.run(
      'INSERT INTO shares (token, thread_id, snapshot, shared_at, shared_by) VALUES (?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET snapshot = excluded.snapshot, shared_at = excluded.shared_at, shared_by = excluded.shared_by',
      token, threadId, snapshot, sharedAt, sharedBy,
    );
    return token;
  }
  deleteShare(threadId: string): void {
    this.run('DELETE FROM shares WHERE thread_id = ?', threadId);
  }

  // People (team server) -----------------------------------------------------

  addThreadPerson(threadId: string, email: string): void {
    this.run('INSERT OR IGNORE INTO thread_people (thread_id, email) VALUES (?, ?)', threadId, email.toLowerCase());
  }
  /** An old DM thread (from before DMs were their own thing): hidden from everyone. */
  isDmThread(threadId: string): boolean {
    return Boolean(this.get('SELECT dm FROM threads WHERE id = ?', threadId)?.dm);
  }
  peopleOfThread(threadId: string): string[] {
    return this.all('SELECT email FROM thread_people WHERE thread_id = ? ORDER BY rowid', threadId).map((r) => r.email as string);
  }
  touchPerson(email: string, now = Date.now()): void {
    this.run(
      'INSERT INTO people (email, first_seen, last_seen) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET last_seen = excluded.last_seen',
      email.toLowerCase(), now, now,
    );
  }
  /** Everyone who has signed in, most recently seen first. */
  people(): string[] {
    return this.all('SELECT email FROM people ORDER BY last_seen DESC').map((r) => r.email as string);
  }
  /**
   * Threads from before people were recorded belong to whoever ran Crew then:
   * the first admin. Returns how many were claimed.
   */
  claimUnownedThreads(email: string): number {
    const ids = this.all('SELECT id FROM threads WHERE created_by IS NULL').map((r) => r.id as string);
    if (!ids.length) return 0;
    this.transaction(() => {
      this.run('UPDATE threads SET created_by = ? WHERE created_by IS NULL', email.toLowerCase());
      for (const id of ids) this.addThreadPerson(id, email);
    });
    return ids.length;
  }

  // Direct messages ----------------------------------------------------------

  /** The DM between exactly these people, made if there is none. */
  dmFor(emails: string[], newId: () => string, now = Date.now()): Dm {
    const key = dmKey(emails);
    let id = this.get('SELECT id FROM dms WHERE key = ?', key)?.id as string | undefined;
    if (!id) {
      id = newId();
      this.run('INSERT INTO dms (id, key, created_at, updated_at) VALUES (?,?,?,?)', id, key, now, now);
      for (const e of new Set(emails.map((x) => x.toLowerCase()))) this.run('INSERT INTO dm_people (dm_id, email) VALUES (?, ?)', id, e);
    }
    return this.dm(id)!;
  }
  dm(id: string): Dm | undefined {
    const r = this.get('SELECT * FROM dms WHERE id = ?', id);
    if (!r) return undefined;
    const last = this.get('SELECT * FROM dm_messages WHERE dm_id = ? ORDER BY id DESC LIMIT 1', id);
    return {
      id,
      people: this.dmPeople(id),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      ...(last ? { last: { by: last.by_email as string, text: last.text as string, ts: Number(last.ts) } } : {}),
    };
  }
  dmPeople(id: string): string[] {
    return this.all('SELECT email FROM dm_people WHERE dm_id = ? ORDER BY email', id).map((r) => r.email as string);
  }
  /** Someone's DMs, most recent first. Ones without a message yet are left out. */
  dmsOf(email: string): Dm[] {
    return this.all(
      `SELECT d.id FROM dms d JOIN dm_people p ON p.dm_id = d.id
        WHERE p.email = ? AND EXISTS (SELECT 1 FROM dm_messages m WHERE m.dm_id = d.id)
        ORDER BY d.updated_at DESC`,
      email.toLowerCase(),
    ).map((r) => this.dm(r.id as string)!);
  }
  /** A DM's messages, oldest first: the latest `limit`, or the ones before message `before`. */
  dmMessages(id: string, limit = 200, before = Number.MAX_SAFE_INTEGER): DmMessage[] {
    return this.all('SELECT * FROM dm_messages WHERE dm_id = ? AND id < ? ORDER BY id DESC LIMIT ?', id, before, limit).map(toDmMessage).reverse();
  }
  /** The message this person already sent with this client id (a retried send). */
  dmMessageByClientId(dmId: string, by: string, clientId: string): DmMessage | undefined {
    const r = this.get('SELECT * FROM dm_messages WHERE dm_id = ? AND by_email = ? AND client_id = ?', dmId, by, clientId);
    return r && toDmMessage(r);
  }
  insertDmMessage(m: Omit<DmMessage, 'id'>, clientId?: string): DmMessage {
    const r = this.db
      .prepare('INSERT INTO dm_messages (dm_id, by_email, text, attachments, ts, client_id) VALUES (?,?,?,?,?,?)')
      .run(m.dmId, m.by, m.text, m.attachments?.length ? JSON.stringify(m.attachments) : null, m.ts, clientId ?? null);
    this.run('UPDATE dms SET updated_at = MAX(updated_at, ?) WHERE id = ?', m.ts, m.dmId);
    return { ...m, id: Number(r.lastInsertRowid) };
  }

  // Threads ------------------------------------------------------------------

  insertThread(t: Omit<Thread, 'roles' | 'statusText' | 'usage'>): void {
    this.run(
      'INSERT INTO threads (id, title, status, root_session_id, created_at, updated_at, archived, benched, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      t.id, t.title, t.status, t.rootSessionId, t.createdAt, t.updatedAt, t.archived ? 1 : 0, JSON.stringify(t.benched), t.createdBy ?? null,
    );
    if (t.createdBy) this.addThreadPerson(t.id, t.createdBy);
  }
  thread(id: string): Omit<Thread, 'roles' | 'statusText' | 'usage'> | undefined {
    const r = this.get('SELECT * FROM threads WHERE id = ?', id);
    return r && toThread(r);
  }
  threads(): Omit<Thread, 'roles' | 'statusText' | 'usage'>[] {
    // Old DM threads are left out: their messages moved to the DM tables.
    return this.all('SELECT * FROM threads WHERE dm = 0 ORDER BY updated_at DESC').map(toThread);
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

  /**
   * Spend and work per day for the last `days` days (today included), with days
   * in the owner's time zone: `tzOffsetMin` is their Date#getTimezoneOffset().
   */
  spend(days: number, tzOffsetMin: number, now = Date.now()): SpendResponse {
    const DAY = 86_400_000;
    const shift = -tzOffsetMin * 60_000;
    const todayStart = Math.floor((now + shift) / DAY) * DAY - shift;
    const since = todayStart - (days - 1) * DAY;
    const day = `date((t.started_at + ${shift}) / 1000, 'unixepoch')`;
    const sums = `COALESCE(SUM(t.cost_usd), 0) AS cost,
        COALESCE(SUM(t.input_tokens), 0) AS input, COALESCE(SUM(t.output_tokens), 0) AS output,
        COALESCE(SUM(CASE WHEN t.cost_usd IS NULL THEN COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0) ELSE 0 END), 0) AS unpriced,
        COUNT(*) AS turns, COUNT(DISTINCT t.thread_id) AS threads,
        COALESCE(SUM(CASE WHEN t.caller_session_id IS NULL AND t.ended_at IS NOT NULL THEN t.ended_at - t.started_at ELSE 0 END), 0) AS work`;
    // Turns that never reached an agent (saved prompts, queued messages) did no work.
    const worked = `t.started_at >= ? AND (t.ended_at IS NULL OR t.ended_at > t.started_at OR t.cost_usd IS NOT NULL OR t.input_tokens IS NOT NULL)`;
    const totals = (r: Row | undefined) => ({
      costUsd: Number(r?.cost ?? 0),
      tokens: Number(r?.input ?? 0) + Number(r?.output ?? 0),
      unpricedTokens: Number(r?.unpriced ?? 0),
      turns: Number(r?.turns ?? 0),
      threads: Number(r?.threads ?? 0),
      workMs: Number(r?.work ?? 0),
    });
    const byDay = new Map(
      this.all(`SELECT ${day} AS day, ${sums} FROM turns t WHERE ${worked} GROUP BY day`, since).map((r) => [String(r.day), totals(r)]),
    );
    const out: SpendDay[] = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(since + i * DAY + shift).toISOString().slice(0, 10);
      out.push({ date, ...(byDay.get(date) ?? totals(undefined)) });
    }
    const agents = this.all(
      `SELECT s.role AS role, ${sums} FROM turns t JOIN sessions s ON s.id = t.session_id WHERE ${worked}
       GROUP BY s.role ORDER BY cost DESC, input + output DESC`,
      since,
    ).map((r) => {
      const { costUsd, tokens, unpricedTokens, turns } = totals(r);
      return { role: String(r.role), costUsd, tokens, unpricedTokens, turns };
    });
    const all = this.get(`SELECT ${sums} FROM turns t WHERE ${worked}`, since);
    return {
      days: out,
      agents,
      totals: { ...totals(all), inputTokens: Number(all?.input ?? 0), outputTokens: Number(all?.output ?? 0) },
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
      'INSERT INTO inbox (id, thread_id, session_id, kind, role, preview_id, url, choices, title, body, status, created_at, for_email, by_email) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      i.id, i.threadId, i.sessionId, i.kind, i.role, i.previewId ?? null, i.url ?? null,
      i.options?.length
        ? JSON.stringify({ options: i.options, recommended: i.recommended, multiSelect: i.multiSelect })
        : i.askEveryTime
          ? JSON.stringify({ askEveryTime: true })
          : null,
      i.title, i.body, i.status, i.createdAt, i.for ?? null, i.by ?? null,
    );
  }
  /** Open mentions of one person in one thread. */
  openMentions(threadId: string, email: string): InboxItem[] {
    return this.all("SELECT * FROM inbox WHERE thread_id = ? AND kind = 'mention' AND for_email = ? AND status = 'open'", threadId, email).map(toInbox);
  }
  /**
   * Messages held for a session: people tagged each other, so the agent waits.
   * Not yet released (by a reply, a message to the agent, or Go ahead) or taken back.
   */
  heldMessages(threadId: string, sessionId: string): CrewEvent[] {
    const held = this.all(
      `SELECT * FROM events WHERE thread_id = ? AND session_id = ? AND type = 'message' AND json_extract(body, '$.delivery') = 'held' ORDER BY id`,
      threadId, sessionId,
    ).map(toEvent);
    if (!held.length) return [];
    // A held message is released (or taken back) by a later delivery event; 'rehold'
    // puts it back when the message that carried it to the agent was taken back.
    const last = new Map<number, string>();
    for (const e of this.all("SELECT * FROM events WHERE thread_id = ? AND session_id = ? AND type = 'message_delivery' ORDER BY id", threadId, sessionId).map(toEvent)) {
      if (e.type === 'message_delivery') last.set(e.messageId, e.state);
    }
    return held.filter((e) => {
      const state = last.get(e.id);
      return state === undefined || state === 'rehold';
    });
  }
  /** The event a queued message is, to find its thread. */
  event(id: number): CrewEvent | undefined {
    const r = this.get('SELECT * FROM events WHERE id = ?', id);
    return r && toEvent(r);
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

  /** An agent's memory entries. Never ones saved in a DM: memory is shared with the whole team. */
  memories(agent: string, memory: string): MemoryRow[] {
    return this.all(
      `SELECT * FROM memories WHERE agent = ? AND memory = ?
         AND (thread_id IS NULL OR thread_id NOT IN (SELECT id FROM threads WHERE dm = 1))
       ORDER BY created_at`,
      agent, memory,
    ).map((r) => ({
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
