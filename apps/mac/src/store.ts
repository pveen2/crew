// Client-side state. Everything comes from the conductor: an initial fetch,
// then live updates over the WebSocket. The app never runs agent logic.

import { useSyncExternalStore } from 'react';
import type {
  AgentActivity,
  AttachmentUpload,
  ConnectionStatus,
  CrewEvent,
  InboxItem,
  RoleSummary,
  ServerMessage,
  Session,
  StateResponse,
  Thread,
  ThreadDetailResponse,
  Turn,
} from '@crew/protocol';

declare global {
  interface Window {
    crewHost?: {
      platform: string;
      conductorInfo: () => Promise<{ url: string; token: string } | null>;
      /** Commits waiting on origin/main (0 outside Crew.app or off a clean main). */
      updateCheck: () => Promise<number>;
      /** Pulls and restarts Crew; resolves with an error message if the pull failed. */
      updateApply: () => Promise<string | null>;
    };
  }
}

export interface ThreadData {
  /** The thread as of the last load (also for closed threads, which are not in the active list). */
  thread: Thread;
  sessions: Record<string, Session>;
  turns: Record<string, Turn>;
  events: CrewEvent[];
}

export type View =
  | { name: 'new'; role?: string }
  | { name: 'threads' }
  | { name: 'done' }
  | { name: 'inbox'; itemId?: string }
  | { name: 'agents' }
  | { name: 'thread'; threadId: string; sessionId?: string };

export interface PreviewDoc {
  id: string;
  title: string;
  format: 'markdown' | 'html';
  content: string;
  from: string;
  ts: number;
}

export interface AppState {
  connection: 'connecting' | 'online' | 'offline';
  /** Engine CLIs and services the team uses, and whether each is signed in. */
  connections: ConnectionStatus[];
  /** Sign-ins opened from the app and still waited on, by connection id. */
  signingIn: Record<string, true>;
  threads: Record<string, Thread>;
  /** Closed threads, shown under Done. */
  done: Record<string, Thread>;
  inbox: Record<string, InboxItem>;
  roles: RoleSummary[];
  teamName: string;
  activity: AgentActivity[];
  details: Record<string, ThreadData>;
  view: View;
  /** Preview selected per thread. */
  preview: Record<string, string | undefined>;
  previewOpen: boolean;
  /** Extra preview docs not produced by show_preview (subagent results opened from a card). */
  extraPreviews: Record<string, PreviewDoc[]>;
  /** Preview tabs the owner closed, per thread. Opening the document again brings it back. */
  closedPreviews: Record<string, Record<string, true>>;
  /** Sidebar folded down to the icon rail. Remembered across launches. */
  sidebarCollapsed: boolean;
  previewDevice: 'desktop' | 'phone';
  /** Width of the preview pane in px, set by dragging; null = the default split. Kept on this Mac. */
  previewWidth: number | null;
  /** Width of the Inbox list in px, set by dragging; null = default. Kept on this Mac. */
  inboxListWidth: number | null;
  inboxFilter: 'all' | 'unread';
  /** Inbox items the owner has looked at. Kept on this Mac only; the conductor has no read state. */
  inboxRead: Record<string, true>;
  /** Threads that could not be loaded (missing or failed), with the reason. */
  loadErrors: Record<string, string>;
}

function viewFromHash(): View {
  const decode = (x: string) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x; // a malformed link should not break the app
    }
  };
  const [name, a, b] = location.hash.replace(/^#\/?/, '').split('/').map((x) => (x ? decode(x) : x));
  if (name === 'thread' && a) return { name: 'thread', threadId: a, sessionId: b || undefined };
  if (name === 'inbox') return { name, itemId: a || undefined };
  if (name === 'threads' || name === 'agents' || name === 'done') return { name };
  return { name: 'new', role: (name === 'new' && a) || undefined };
}

function hashOf(view: View): string {
  switch (view.name) {
    case 'thread':
      return `#thread/${view.threadId}${view.sessionId ? `/${view.sessionId}` : ''}`;
    case 'inbox':
      return view.itemId ? `#inbox/${encodeURIComponent(view.itemId)}` : '#inbox';
    case 'new':
      return view.role ? `#new/${encodeURIComponent(view.role)}` : '#new';
    default:
      return `#${view.name}`;
  }
}

const READ_KEY = 'crew.inbox.read';
function loadRead(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY) ?? '{}') as Record<string, true>;
  } catch {
    return {};
  }
}

const SIDEBAR_KEY = 'crew.sidebar.collapsed';
const PREVIEW_WIDTH_KEY = 'crew.preview.width';
const INBOX_LIST_WIDTH_KEY = 'crew.inbox.listWidth';
function loadWidth(key: string): number | null {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

let state: AppState = {
  connection: 'connecting',
  connections: [],
  signingIn: {},
  threads: {},
  done: {},
  inbox: {},
  roles: [],
  teamName: '',
  activity: [],
  details: {},
  view: viewFromHash(),
  preview: {},
  previewOpen: true,
  extraPreviews: {},
  closedPreviews: {},
  sidebarCollapsed: loadFlag(SIDEBAR_KEY),
  previewDevice: 'desktop',
  previewWidth: loadWidth(PREVIEW_WIDTH_KEY),
  inboxListWidth: loadWidth(INBOX_LIST_WIDTH_KEY),
  inboxFilter: 'all',
  inboxRead: loadRead(),
  loadErrors: {},
};

const listeners = new Set<() => void>();
function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

export const getState = () => state;

// ---------------------------------------------------------------------------
// Connection

let conn: { url: string; token: string } | null = null;

async function resolveConductor(): Promise<{ url: string; token: string } | null> {
  if (window.crewHost) return window.crewHost.conductorInfo();
  // Plain browser (development): ?conductor=http://127.0.0.1:4317&token=...
  const q = new URLSearchParams(location.search);
  const token = q.get('token');
  if (!token) return null;
  return { url: q.get('conductor') ?? 'http://127.0.0.1:4317', token };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!conn) throw new Error('Not connected to the conductor');
  const res = await fetch(conn.url + path, {
    method,
    headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok || (json && typeof json === 'object' && 'error' in json && json.error)) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

let refreshTimer: number | undefined;
function scheduleStateRefresh(): void {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refreshState(), 400);
}

async function refreshState(): Promise<void> {
  const s = await api<StateResponse>('GET', '/api/state');
  set({
    threads: Object.fromEntries(s.threads.map((t) => [t.id, t])),
    done: Object.fromEntries(s.done.map((t) => [t.id, t])),
    inbox: Object.fromEntries(s.inbox.map((i) => [i.id, i])),
    roles: s.roles,
    teamName: s.team.name,
    activity: s.activity,
  });
}

function onMessage(msg: ServerMessage): void {
  // Until the first snapshot is in, hold socket messages and replay them after it.
  if (pending) {
    pending.push(msg);
    return;
  }
  switch (msg.kind) {
    case 'thread':
      set((s) => {
        const threads = { ...s.threads };
        const done = { ...s.done };
        if (msg.thread.archived) {
          delete threads[msg.thread.id];
          done[msg.thread.id] = msg.thread;
        } else {
          threads[msg.thread.id] = msg.thread;
          delete done[msg.thread.id];
        }
        return { threads, done };
      });
      scheduleStateRefresh();
      break;
    case 'inbox':
      set((s) => {
        const inbox = { ...s.inbox };
        if (msg.item.status === 'open') inbox[msg.item.id] = msg.item;
        else delete inbox[msg.item.id];
        return { inbox };
      });
      break;
    case 'session':
      set((s) => {
        const d = s.details[msg.session.threadId];
        if (!d) return {};
        return { details: { ...s.details, [msg.session.threadId]: { ...d, sessions: { ...d.sessions, [msg.session.id]: msg.session } } } };
      });
      scheduleStateRefresh();
      break;
    case 'turn':
      break;
    case 'event': {
      const e = msg.event;
      set((s) => {
        const d = s.details[e.threadId];
        if (!d || d.events.some((x) => x.id === e.id)) return {};
        const patch: Partial<AppState> = { details: { ...s.details, [e.threadId]: { ...d, events: [...d.events, e] } } };
        // A new preview becomes the selected one, and opens the pane.
        if (e.type === 'preview') {
          patch.preview = { ...s.preview, [e.threadId]: e.previewId };
          patch.previewOpen = true;
        }
        return patch;
      });
      // A session we have not seen yet (a new specialist): load it.
      if (state.details[e.threadId] && !state.details[e.threadId]!.sessions[e.sessionId]) void loadThread(e.threadId);
      if (e.type === 'subagent_started' && state.details[e.threadId] && !state.details[e.threadId]!.sessions[e.childSessionId]) {
        void loadThread(e.threadId);
      }
      if (e.type === 'tool_call' || e.type === 'subagent_started' || e.type === 'turn_done') scheduleStateRefresh();
      break;
    }
  }
}

let ws: WebSocket | null = null;
/** Socket messages that arrived before the snapshot they must be applied on top of. */
let pending: ServerMessage[] | null = null;

function retry(ms: number): void {
  set({ connection: 'offline' });
  setTimeout(() => void connect(), ms);
}

/**
 * Subscribe first, then fetch: anything that happens while the snapshot is in
 * flight is buffered and replayed on top of it, so nothing is lost.
 */
export async function connect(): Promise<void> {
  set({ connection: 'connecting' });
  conn = await resolveConductor();
  if (!conn) return retry(2000);

  const socket = new WebSocket(conn.url.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(conn.token)}`);
  ws = socket;
  pending = [];
  socket.onmessage = (m) => onMessage(JSON.parse(String(m.data)) as ServerMessage);
  socket.onclose = () => {
    if (ws === socket) retry(1500);
  };
  const opened = await new Promise<boolean>((resolve) => {
    socket.onopen = () => resolve(true);
    socket.onerror = () => resolve(false);
  });
  if (!opened) return;

  try {
    // Keep only the thread on screen; everything else reloads when it is opened again.
    const current = state.view.name === 'thread' ? state.view.threadId : undefined;
    set((s) => ({ details: current && s.details[current] ? { [current]: s.details[current]! } : {} }));
    await refreshState();
    if (current) await loadThread(current);
  } catch {
    pending = null;
    socket.close();
    return;
  }
  const buffered = pending;
  pending = null;
  for (const msg of buffered) onMessage(msg);
  set({ connection: 'online' });
  navigate(state.view);
  void loadConnections();
}

// ---------------------------------------------------------------------------
// Actions

const MAX_CACHED_THREADS = 8;

export async function loadThread(threadId: string): Promise<void> {
  let d: ThreadDetailResponse;
  try {
    d = await api<ThreadDetailResponse>('GET', `/api/threads/${threadId}`);
  } catch (err) {
    set((s) => ({ loadErrors: { ...s.loadErrors, [threadId]: (err as Error).message } }));
    return;
  }
  set((s) => {
    const lastPreview = [...d.events].reverse().find((e) => e.type === 'preview');
    // Events the socket delivered after this snapshot was taken stay.
    const lastId = d.events.at(-1)?.id ?? 0;
    const newer = (s.details[threadId]?.events ?? []).filter((e) => e.id > lastId);
    // Bound the cache: keep the most recently loaded threads only.
    const kept = Object.keys(s.details).filter((id) => id !== threadId).slice(-(MAX_CACHED_THREADS - 1));
    const details = Object.fromEntries(kept.map((id) => [id, s.details[id]!]));
    const { [threadId]: _gone, ...loadErrors } = s.loadErrors;
    return {
      loadErrors,
      details: {
        ...details,
        [threadId]: {
          thread: d.thread,
          sessions: Object.fromEntries(d.sessions.map((x) => [x.id, x])),
          turns: Object.fromEntries(d.turns.map((x) => [x.id, x])),
          events: [...d.events, ...newer],
        },
      },
      // A closed (archived) thread can be viewed by link, but never rejoins the active list.
      threads: d.thread.archived ? s.threads : { ...s.threads, [threadId]: d.thread },
      preview: s.preview[threadId] || !lastPreview || lastPreview.type !== 'preview' ? s.preview : { ...s.preview, [threadId]: lastPreview.previewId },
    };
  });
}

window.addEventListener('hashchange', () => {
  const v = viewFromHash();
  if (hashOf(v) !== hashOf(state.view)) navigate(v);
});

export function navigate(view: View): void {
  set({ view });
  if (location.hash !== hashOf(view)) history.replaceState(null, '', hashOf(view));
  if (view.name === 'thread') {
    if (!state.details[view.threadId]) void loadThread(view.threadId);
    // Looking at a thread counts as reading its Inbox items.
    markRead(Object.values(state.inbox).filter((i) => i.threadId === view.threadId).map((i) => i.id));
  }
  if (view.name === 'inbox' && view.itemId) {
    markRead([view.itemId]);
    const item = state.inbox[view.itemId];
    if (item && !state.details[item.threadId]) void loadThread(item.threadId);
  }
}

export function toggleSidebar(collapsed = !state.sidebarCollapsed): void {
  set({ sidebarCollapsed: collapsed });
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

export function markRead(ids: string[]): void {
  const fresh = ids.filter((id) => !state.inboxRead[id]);
  if (!fresh.length) return;
  set((s) => {
    const inboxRead = { ...s.inboxRead };
    for (const id of fresh) inboxRead[id] = true;
    try {
      localStorage.setItem(READ_KEY, JSON.stringify(inboxRead));
    } catch {
      /* storage full or unavailable: read state stays in memory */
    }
    return { inboxRead };
  });
}

export function setInboxFilter(inboxFilter: 'all' | 'unread'): void {
  set({ inboxFilter });
}

function saveWidth(key: string, width: number | null): void {
  try {
    if (width == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // Not persisted; the width still applies until the app restarts.
  }
}

export function setPreviewWidth(previewWidth: number | null): void {
  set({ previewWidth });
  saveWidth(PREVIEW_WIDTH_KEY, previewWidth);
}

export function setInboxListWidth(inboxListWidth: number | null): void {
  set({ inboxListWidth });
  saveWidth(INBOX_LIST_WIDTH_KEY, inboxListWidth);
}

export function setPreviewDevice(previewDevice: 'desktop' | 'phone'): void {
  set({ previewDevice });
}

/** Load thread details in the background (e.g. to know which agent raised an Inbox item). */
export function ensureThreads(ids: string[]): void {
  for (const id of new Set(ids)) if (!state.details[id]) void loadThread(id).catch(() => undefined);
}

/** Read picked or pasted image files for upload. */
async function toUploads(files: File[] = []): Promise<AttachmentUpload[]> {
  return Promise.all(
    files.map(async (f) => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { name: f.name || 'image', mime: f.type, data: btoa(bin) };
    }),
  );
}

const attachmentUrls = new Map<string, Promise<string>>();
/** An attached image as a blob: URL (fetched with the app token, cached). */
export function attachmentUrl(threadId: string, file: string): Promise<string> {
  const key = `${threadId}/${file}`;
  let p = attachmentUrls.get(key);
  if (!p) {
    p = (async () => {
      if (!conn) throw new Error('Not connected to the conductor');
      const res = await fetch(`${conn.url}/api/attachments/${encodeURIComponent(threadId)}/${encodeURIComponent(file)}`, {
        headers: { authorization: `Bearer ${conn.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return URL.createObjectURL(await res.blob());
    })();
    p.catch(() => attachmentUrls.delete(key));
    attachmentUrls.set(key, p);
  }
  return p;
}

export async function createThread(text: string, role?: string, files?: File[]): Promise<void> {
  const t = await api<Thread>('POST', '/api/threads', { text, role, attachments: await toUploads(files) });
  set((s) => ({ threads: { ...s.threads, [t.id]: t } }));
  navigate({ name: 'thread', threadId: t.id });
}

/** `replyTo`: the Inbox question this answers; only that question is resolved. */
export async function sendMessage(threadId: string, text: string, sessionId?: string, replyTo?: string, files?: File[]): Promise<void> {
  await api('POST', `/api/threads/${threadId}/messages`, { text, sessionId, replyTo, attachments: await toUploads(files) });
}

/** Change a queued message before the agent has it. */
export async function editQueuedMessage(messageId: number, text: string): Promise<void> {
  await api('POST', `/api/messages/${messageId}/edit`, { text });
}

/** Take back a queued message before the agent has it. */
export async function removeQueuedMessage(messageId: number): Promise<void> {
  await api('POST', `/api/messages/${messageId}/remove`);
}

export async function resumeThread(threadId: string): Promise<void> {
  await api('POST', `/api/threads/${threadId}/resume`);
}

export async function resumeSession(sessionId: string): Promise<void> {
  await api('POST', `/api/sessions/${sessionId}/resume`);
}

export async function stopSession(sessionId: string): Promise<void> {
  await api('POST', `/api/sessions/${sessionId}/stop`);
}

export async function archiveThread(threadId: string): Promise<void> {
  await api('POST', `/api/threads/${threadId}/archive`);
  if (state.view.name === 'thread' && state.view.threadId === threadId) navigate({ name: 'threads' });
}

export async function resolveInbox(id: string): Promise<void> {
  await api('POST', `/api/inbox/${id}/resolve`);
}

export async function decideApproval(id: string, approved: boolean): Promise<void> {
  await api('POST', `/api/inbox/${id}/${approved ? 'approve' : 'deny'}`);
}

export function selectPreview(threadId: string, previewId: string): void {
  set((s) => {
    const closed = { ...(s.closedPreviews[threadId] ?? {}) };
    delete closed[previewId];
    return { preview: { ...s.preview, [threadId]: previewId }, previewOpen: true, closedPreviews: { ...s.closedPreviews, [threadId]: closed } };
  });
}

/** Close a preview tab. `remaining` are the open tabs in order; the neighbour becomes selected, or the pane closes. */
export function closePreview(threadId: string, previewId: string, remaining: string[]): void {
  set((s) => {
    const idx = remaining.indexOf(previewId);
    const left = remaining.filter((id) => id !== previewId);
    const wasSelected = (s.preview[threadId] ?? remaining.at(-1)) === previewId;
    const next = wasSelected ? (left[Math.min(idx, left.length - 1)] ?? '') : s.preview[threadId];
    return {
      closedPreviews: { ...s.closedPreviews, [threadId]: { ...(s.closedPreviews[threadId] ?? {}), [previewId]: true } },
      extraPreviews: { ...s.extraPreviews, [threadId]: (s.extraPreviews[threadId] ?? []).filter((d) => d.id !== previewId) },
      preview: next ? { ...s.preview, [threadId]: next } : s.preview,
      previewOpen: left.length ? s.previewOpen : false,
    };
  });
}

export function openAsPreview(threadId: string, doc: PreviewDoc): void {
  set((s) => {
    const list = (s.extraPreviews[threadId] ?? []).filter((d) => d.id !== doc.id);
    return {
      extraPreviews: { ...s.extraPreviews, [threadId]: [...list, doc] },
      preview: { ...s.preview, [threadId]: doc.id },
      previewOpen: true,
    };
  });
}

export function togglePreview(open?: boolean): void {
  set((s) => ({ previewOpen: open ?? !s.previewOpen }));
}

export function roleOf(name: string): RoleSummary | undefined {
  return state.roles.find((r) => r.name === name);
}

// ---------------------------------------------------------------------------
// Connections (engine sign-ins, Shopify, browser)

export async function loadConnections(refresh = false): Promise<void> {
  try {
    const connections = await api<ConnectionStatus[]>('GET', `/api/connections${refresh ? '?refresh=1' : ''}`);
    set((s) => {
      // A sign-in is done once its connection reports connected.
      const signingIn = { ...s.signingIn };
      for (const c of connections) if (c.status === 'connected') delete signingIn[c.id];
      return { connections, signingIn };
    });
  } catch {
    // Offline: keep what we had; the next connect loads it again.
  }
}

let signInPoll: number | undefined;
const SIGN_IN_WAIT_MS = 5 * 60_000;
/** When each open sign-in stops being waited on. */
const signInDeadline = new Map<string, number>();

function stopWaiting(ids: string[]): void {
  for (const id of ids) signInDeadline.delete(id);
  set((s) => {
    const signingIn = { ...s.signingIn };
    for (const id of ids) delete signingIn[id];
    return { signingIn };
  });
}

/** Open the sign-in (or install) in Terminal, then check back until it is connected. */
export async function signInConnection(id: string): Promise<void> {
  set((s) => ({ signingIn: { ...s.signingIn, [id]: true } }));
  signInDeadline.set(id, Date.now() + SIGN_IN_WAIT_MS);
  try {
    await api('POST', `/api/connections/${encodeURIComponent(id)}/sign-in`);
  } catch (err) {
    stopWaiting([id]);
    window.alert((err as Error).message);
    return;
  }
  // One poll for all open sign-ins; each has its own deadline.
  if (signInPoll === undefined) {
    signInPoll = window.setInterval(() => {
      const now = Date.now();
      stopWaiting([...signInDeadline].filter(([x, until]) => now > until || !state.signingIn[x]).map(([x]) => x));
      if (!signInDeadline.size) {
        window.clearInterval(signInPoll);
        signInPoll = undefined;
        return;
      }
      void loadConnections(true);
    }, 4000);
  }
}

// Coming back from Terminal or the browser: check again, past the cache.
window.addEventListener('focus', () => {
  if (state.connection === 'online') void loadConnections(true);
});
