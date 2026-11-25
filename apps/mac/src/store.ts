// Client-side state. Everything comes from the conductor: an initial fetch,
// then live updates over the WebSocket. The app never runs agent logic.

import { useSyncExternalStore } from 'react';
import { applyTouchIcon, isTouchIcon, type TouchIcon } from './touchIcon';
import type {
  AgentActivity,
  AttachmentUpload,
  BrandFont,
  DocResponse,
  DocStatus,
  DocSummary,
  ConnectionStatus,
  CrewEvent,
  InboxItem,
  RoleSummary,
  ServerMessage,
  SpendResponse,
  Session,
  StateResponse,
  Thread,
  ThreadDetailResponse,
  ThreadShare,
  ClientMessage,
  Person,
  Turn,
  ServerLogin,
} from '@crew/protocol';
import { namePeople } from '@crew/protocol';

/** An update the sidebar offers. */
export interface UpdateInfo {
  /** Short text on the button: a commit count or a version. */
  badge: string;
  /** What clicking does. */
  title: string;
  /** True when applying restarts the conductor too, which stops running agents. */
  stopsAgents: boolean;
}

/** Where the team comes from (installed app only). */
export type TeamSource =
  | { kind: 'example' }
  | { kind: 'github'; repo: string; path: string; branch: string }
  | { kind: 'folder'; dir: string };

/** Where Crew runs: this Mac's own conductor, or a server (behind Cloudflare Access). */
export type WhereInfo = { mode: 'local' | 'server'; url: string | null; /** Set outside the app (a checkout, or CREW_CONDUCTOR_URL). */ fixed: boolean };

export type TeamInfo = TeamSource & {
  /** False when this app does not run its own conductor (running from a checkout, or a server). */
  supported: boolean;
  teamDir: string;
  /** The folder has agent/agent.ts. */
  ready: boolean;
  /** Short commit and subject of Crew's clone (GitHub teams). */
  revision?: string;
};

declare global {
  interface Window {
    crewHost?: {
      platform: string;
      startConductor?: () => Promise<void>;
      conductorInfo: () => Promise<{ url: string; token: string } | null>;
      /**
       * A waiting update, or null: new commits on main (running from a checkout)
       * or a new release on GitHub (installed from the DMG).
       */
      updateCheck: () => Promise<UpdateInfo | null>;
      /** Installs it (restart, or the download page); resolves with an error message if that failed. */
      updateApply: () => Promise<string | null>;
      whereInfo?: () => Promise<WhereInfo>;
      /** Switches between this Mac and a server; resolves with an error message, or null (the window then reloads). */
      whereSet?: (next: { mode: 'local' | 'server'; url?: string }) => Promise<string | null>;
      teamInfo?: () => Promise<TeamInfo>;
      /** Switches the team and restarts the conductor; resolves with an error message, or null. */
      teamSet?: (next: TeamSource) => Promise<string | null>;
      teamChooseFolder?: () => Promise<string | null>;
      /** New commits for a GitHub team, or null. */
      teamCheck?: () => Promise<UpdateInfo | null>;
      teamApply?: () => Promise<string | null>;
      openExternal?: (url: string) => Promise<void>;
      /** Catches a server sign-in's return to 127.0.0.1:<port> on this Mac and passes it to the server. */
      loginRelay?: (port: number, loginId: string) => Promise<string | null>;
      onOpenUrl?: (cb: (url: string) => void) => () => void;
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
  | { name: 'docs'; docId?: string }
  | { name: 'agents' }
  | { name: 'team' }
  | { name: 'settings' }
  | { name: 'thread'; threadId: string; sessionId?: string };

/** To review: drafts not archived. One row per thread in each. */
export type DocsFilter = 'review' | 'approved' | 'archived';

export interface PreviewDoc {
  id: string;
  title: string;
  /** 'web' is a browser tab: `content` is its current URL. */
  format: 'markdown' | 'html' | 'concepts' | 'web';
  content: string;
  /** The doc behind it (Docs tab), when there is one. */
  artifactId?: string;
  from: string;
  ts: number;
}

export interface AppState {
  connection: 'connecting' | 'online' | 'offline';
  conductorStarting: boolean;
  conductorStartError: string | null;
  /** Engine CLIs and services the team uses, and whether each is signed in. */
  connections: ConnectionStatus[];
  /** Sign-ins opened from the app and still waited on, by connection id. */
  signingIn: Record<string, true>;
  /** A sign-in running on the server (the app shows its link and code). */
  serverLogin: ServerLogin | null;
  serverLoginError: string | null;
  threads: Record<string, Thread>;
  /** Closed threads, shown under Done. */
  done: Record<string, Thread>;
  inbox: Record<string, InboxItem>;
  roles: RoleSummary[];
  teamName: string;
  /** The team's brand fonts (crew.config.ts `fonts`), for concept boards. */
  teamFonts: BrandFont[];
  /** Example questions on the New thread screen, from the team. */
  suggestions: string[];
  activity: AgentActivity[];
  /** Threads can get a read-only share link (a team server). */
  sharing: boolean;
  /** Each loaded thread's share link; null when it is not shared. */
  shares: Record<string, ThreadShare | null>;
  /** Team server: who is signed in (null on a Mac: one person, no Mine/All). */
  me: string | null;
  /** Team server: everyone who has signed in. */
  people: Person[];
  /** Threads and Inbox: only mine, or the whole team's. */
  scope: Scope;
  /** DMs: when each was last looked at on this device. */
  dmSeen: Record<string, number>;
  /** Team server: who has each thread open right now, and who is typing in it. */
  presence: Record<string, { viewing: string[]; typing: string[] }>;
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
  /** On a phone: the sidebar is open over the page. */
  navOpen: boolean;
  /** Show what threads and agents spent (Settings). On unless switched off; kept on this Mac. */
  showSpend: boolean;
  /** Sidebar colours: the dark default or a light one (Settings). Kept on this Mac. */
  sidebarTheme: SidebarTheme;
  /** Which icon an iPhone gets when the web app is added to the home screen (Settings). Kept on this device. */
  touchIcon: TouchIcon;
  previewDevice: 'desktop' | 'phone';
  /** Width of the preview pane in px, set by dragging; null = the default split. Kept on this Mac. */
  previewWidth: number | null;
  /** Width of the Inbox list in px, set by dragging; null = default. Kept on this Mac. */
  inboxListWidth: number | null;
  inboxFilter: 'all' | 'unread';
  /** Docs the owner was shown (Docs tab), by id. Null until loaded. */
  docs: Record<string, DocSummary> | null;
  /** All: what is not archived. Archived: only the archive. */
  docsFilter: DocsFilter;
  /** Docs the owner has opened, and when this Mac started counting (older docs count as seen). */
  docsSeen: { since: number; ids: Record<string, true> };
  /** Inbox items the owner has looked at. Kept on this Mac only; the conductor has no read state. */
  inboxRead: Record<string, true>;
  /** Threads that could not be loaded (missing or failed), with the reason. */
  loadErrors: Record<string, string>;
  /** What the New thread screen opens with once ("Run again" from a thread). */
  newDraft: NewThreadDraft | null;
}

export interface NewThreadDraft {
  text: string;
  role?: string;
  /** Specialists switched off. */
  benched: string[];
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
  if (name === 'docs') return { name, docId: a || undefined };
  if (name === 'threads' || name === 'agents' || name === 'done' || name === 'team' || name === 'settings') return { name };
  return { name: 'new', role: (name === 'new' && a) || undefined };
}

function hashOf(view: View): string {
  switch (view.name) {
    case 'thread':
      return `#thread/${view.threadId}${view.sessionId ? `/${view.sessionId}` : ''}`;
    case 'inbox':
      return view.itemId ? `#inbox/${encodeURIComponent(view.itemId)}` : '#inbox';
    case 'docs':
      return view.docId ? `#docs/${encodeURIComponent(view.docId)}` : '#docs';
    case 'new':
      return view.role ? `#new/${encodeURIComponent(view.role)}` : '#new';
    default:
      return `#${view.name}`;
  }
}

const DOCS_SEEN_KEY = 'crew.docs.seen';
function loadDocsSeen(): AppState['docsSeen'] {
  try {
    const v = JSON.parse(localStorage.getItem(DOCS_SEEN_KEY) ?? 'null') as AppState['docsSeen'] | null;
    if (v && typeof v.since === 'number' && v.ids) return v;
  } catch {
    /* fall through: start counting now */
  }
  const fresh = { since: Date.now(), ids: {} };
  try {
    localStorage.setItem(DOCS_SEEN_KEY, JSON.stringify(fresh));
  } catch {
    /* storage unavailable */
  }
  return fresh;
}

/** A draft the owner has not opened (or archived) yet: counts on Docs in the sidebar. */
export function isNewDoc(d: DocSummary, seen: AppState['docsSeen']): boolean {
  return d.status === 'draft' && !d.archivedAt && d.shownAt > seen.since && !seen.ids[d.id];
}

export function markDocSeen(id: string): void {
  if (state.docsSeen.ids[id]) return;
  set((s) => {
    const docsSeen = { since: s.docsSeen.since, ids: { ...s.docsSeen.ids, [id]: true as const } };
    try {
      localStorage.setItem(DOCS_SEEN_KEY, JSON.stringify(docsSeen));
    } catch {
      /* storage full or unavailable: stays in memory */
    }
    return { docsSeen };
  });
}

const READ_KEY = 'crew.inbox.read';
function loadRead(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY) ?? '{}') as Record<string, true>;
  } catch {
    return {};
  }
}

const DM_SEEN_KEY = 'crew.dm.seen';
function loadDmSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(DM_SEEN_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

export type Scope = 'mine' | 'all';
const SCOPE_KEY = 'crew.scope';
function loadScope(): Scope {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'mine';
  } catch {
    return 'mine';
  }
}

/** Threads and Inbox: show only mine, or the whole team's. Remembered on this device. */
export function setScope(scope: Scope): void {
  set({ scope });
  try {
    localStorage.setItem(SCOPE_KEY, scope);
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

/** Mine: I started it, wrote in it or was tagged. Without people (a Mac) everything is mine. */
export function isMine(thread: Thread | undefined, me: string | null): boolean {
  if (!me || !thread) return true;
  return thread.createdBy === me || Boolean(thread.people?.includes(me));
}

/** Whether a thread shows under the current scope. */
export function inScope(thread: Thread | undefined, s: Pick<AppState, 'me' | 'scope'>): boolean {
  return s.scope === 'all' || isMine(thread, s.me);
}

/** "juliette@…" → "Juliette" ("Paul Veen" when there are two Pauls), as the conductor names people. */
export function personName(email: string, people: Person[] = state.people): string {
  const known = people.find((p) => p.email === email);
  if (known) return known.name;
  return namePeople([...people.map((p) => p.email), email]).get(email.toLowerCase()) ?? email;
}

const SIDEBAR_KEY = 'crew.sidebar.collapsed';
const SHOW_SPEND_KEY = 'crew.settings.showSpend';
const SIDEBAR_THEME_KEY = 'crew.settings.sidebarTheme';
const TOUCH_ICON_KEY = 'crew.settings.touchIcon';
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
function loadTouchIcon(): TouchIcon {
  try {
    const v = localStorage.getItem(TOUCH_ICON_KEY);
    return isTouchIcon(v) ? v : 'orange';
  } catch {
    return 'orange';
  }
}
function loadFlag(key: string, fallback = false): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

export type SidebarTheme = 'dark' | 'light';
function loadSidebarTheme(): SidebarTheme {
  try {
    return localStorage.getItem(SIDEBAR_THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
/** Sets the theme on <html>, where tokens.css swaps the sidebar colours, and the phone status bar colour. */
function applySidebarTheme(theme: SidebarTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.sidebar = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f8f5ed' : '#111111');
}
applySidebarTheme(loadSidebarTheme());

/** The app in a phone-sized window (the web app on an iPhone): one pane at a time. */
export function isPhone(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
}

/** Served by a conductor behind Cloudflare Access (no Electron, no ?token= for development). */
export const webApp = !window.crewHost && !new URLSearchParams(location.search).has('token');

/** Opens a link outside the app: the system browser on the Mac, a new tab on the web. */
export function openExternal(url: string): void {
  if (window.crewHost) void window.crewHost.openExternal?.(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

let state: AppState = {
  connection: 'connecting',
  conductorStarting: false,
  conductorStartError: null,
  connections: [],
  signingIn: {},
  serverLogin: null,
  serverLoginError: null,
  threads: {},
  done: {},
  inbox: {},
  roles: [],
  teamName: '',
  teamFonts: [],
  suggestions: [],
  activity: [],
  sharing: false,
  shares: {},
  me: null,
  people: [],
  scope: loadScope(),
  dmSeen: loadDmSeen(),
  presence: {},
  details: {},
  view: viewFromHash(),
  preview: {},
  // On a phone the preview covers the thread, so it opens only when asked.
  previewOpen: !isPhone(),
  extraPreviews: {},
  closedPreviews: {},
  sidebarCollapsed: loadFlag(SIDEBAR_KEY),
  navOpen: false,
  showSpend: loadFlag(SHOW_SPEND_KEY, true),
  sidebarTheme: loadSidebarTheme(),
  touchIcon: loadTouchIcon(),
  previewDevice: 'desktop',
  previewWidth: loadWidth(PREVIEW_WIDTH_KEY),
  inboxListWidth: loadWidth(INBOX_LIST_WIDTH_KEY),
  inboxFilter: 'all',
  docs: null,
  docsFilter: 'review',
  docsSeen: loadDocsSeen(),
  inboxRead: loadRead(),
  loadErrors: {},
  newDraft: null,
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
  // The web app: the conductor that served this page, signed in through Cloudflare
  // Access (its cookie goes along with every request); no app token.
  if (webApp) return { url: location.origin, token: '' };
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
    headers: { ...(conn.token && { authorization: `Bearer ${conn.token}` }), 'content-type': 'application/json' },
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
    teamFonts: s.team.fonts ?? [],
    suggestions: s.team.suggestions,
    activity: s.activity,
    sharing: Boolean(s.sharing),
    me: s.me ?? null,
    people: s.people ?? [],
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
    case 'presence':
      set((s) => ({ presence: { ...s.presence, [msg.threadId]: { viewing: msg.viewing, typing: msg.typing } } }));
      break;
    case 'doc':
      // While a Docs snapshot is loading, keep updates to replay on top of it.
      docUpdatesDuringLoad?.push(msg.doc);
      set((s) => (s.docs ? { docs: { ...s.docs, [msg.doc.id]: msg.doc } } : {}));
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
          // On a phone it would cover the thread: the card in the chat opens it.
          if (!isPhone()) patch.previewOpen = true;
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

let startTimeout: number | undefined;

export async function startConductor(): Promise<void> {
  const launch = window.crewHost?.startConductor;
  if (!launch || state.connection !== 'offline' || state.conductorStarting) return;
  set({ conductorStarting: true, conductorStartError: null });
  try {
    await launch();
    if (!state.conductorStarting) return;
    startTimeout = window.setTimeout(() => set({
      conductorStarting: false,
      conductorStartError: 'Still offline. Check conductor.log in your Crew logs folder, then try again.',
    }), 15_000);
  } catch (err) {
    set({ conductorStarting: false, conductorStartError: (err as Error).message });
  }
}

/**
 * The web app: when the Cloudflare Access login has run out, Access answers with a
 * redirect to its sign-in page, which a fetch or WebSocket cannot follow. Reload
 * the page so the browser goes through the sign-in. At most once a minute, so a
 * conductor that is simply down does not reload the page in a loop.
 */
async function accessExpired(): Promise<void> {
  try {
    const res = await fetch('/api/state', { redirect: 'manual', cache: 'no-store' });
    if (res.type !== 'opaqueredirect' && res.status !== 401 && res.status !== 403) return;
  } catch {
    return; // offline: keep retrying quietly
  }
  const KEY = 'crew.access.reloadedAt';
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 60_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {}
  location.reload();
}

function retry(ms: number): void {
  set({ connection: 'offline' });
  setTimeout(() => void connect(), ms);
}

/**
 * Subscribe first, then fetch: anything that happens while the snapshot is in
 * flight is buffered and replayed on top of it, so nothing is lost.
 */
export async function connect(): Promise<void> {
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
  if (!opened) {
    if (webApp) void accessExpired();
    return;
  }

  try {
    // Keep only the thread on screen; everything else reloads when it is opened again.
    const current = state.view.name === 'thread' ? state.view.threadId : undefined;
    set((s) => ({ details: current && s.details[current] ? { [current]: s.details[current]! } : {} }));
    await refreshState();
    // Docs: the sidebar counts new drafts.
    void loadDocs().catch(() => undefined);
    if (current) await loadThread(current);
  } catch {
    pending = null;
    socket.close();
    return;
  }
  const buffered = pending;
  pending = null;
  for (const msg of buffered) onMessage(msg);
  window.clearTimeout(startTimeout);
  set({ connection: 'online', conductorStarting: false, conductorStartError: null });
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
      ...(d.share !== undefined ? { shares: { ...s.shares, [threadId]: d.share } } : {}),
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
  set({ view, navOpen: false });
  sendPresence();
  if (location.hash !== hashOf(view)) history.replaceState(null, '', hashOf(view));
  if (view.name === 'thread') {
    if (!state.details[view.threadId]) void loadThread(view.threadId);
    // Looking at a thread counts as reading its Inbox items.
    markRead(Object.values(state.inbox).filter((i) => i.threadId === view.threadId).map((i) => i.id));
  }
  if (view.name === 'docs' && view.docId) markDocSeen(view.docId);
  if (view.name === 'inbox' && view.itemId) {
    markRead([view.itemId]);
    const item = state.inbox[view.itemId];
    if (item && !state.details[item.threadId]) void loadThread(item.threadId);
  }
}

/** On a phone: opens or closes the sidebar over the page. */
export function toggleNav(open = !state.navOpen): void {
  set({ navOpen: open });
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

export function setTouchIcon(touchIcon: TouchIcon): void {
  set({ touchIcon });
  applyTouchIcon(touchIcon);
  try {
    localStorage.setItem(TOUCH_ICON_KEY, touchIcon);
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

export function setShowSpend(showSpend: boolean): void {
  set({ showSpend });
  try {
    localStorage.setItem(SHOW_SPEND_KEY, showSpend ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

export function setSidebarTheme(sidebarTheme: SidebarTheme): void {
  set({ sidebarTheme });
  applySidebarTheme(sidebarTheme);
  try {
    localStorage.setItem(SIDEBAR_THEME_KEY, sidebarTheme);
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

/** Doc updates that arrived while a snapshot was loading: newer than it, so applied after. */
let docUpdatesDuringLoad: DocSummary[] | null = null;
let docLoads = 0;

export async function loadDocs(): Promise<void> {
  docUpdatesDuringLoad ??= [];
  docLoads++;
  try {
    const docs = await api<DocSummary[]>('GET', '/api/docs');
    const byId: Record<string, DocSummary> = Object.fromEntries(docs.map((d) => [d.id, d]));
    for (const d of docUpdatesDuringLoad ?? []) byId[d.id] = d;
    set({ docs: byId });
  } finally {
    if (--docLoads === 0) docUpdatesDuringLoad = null;
  }
}

/** Spend and work per day for the last `days` days, in this Mac's time zone. */
export function loadSpend(days = 30): Promise<SpendResponse> {
  return api<SpendResponse>('GET', `/api/spend?days=${days}&tz=${new Date().getTimezoneOffset()}`);
}

/** One doc's summary by id, for a doc that is not in the list yet. */
export async function ensureDoc(id: string): Promise<void> {
  const d = await loadDoc(id);
  const { content: _content, ...summary } = d;
  set((s) => (s.docs && !s.docs[id] ? { docs: { ...s.docs, [id]: summary } } : {}));
}

const docContents = new Map<string, Promise<DocResponse>>();
/** A doc with its content (cached: a doc's content never changes, only its status). */
export function loadDoc(id: string): Promise<DocResponse> {
  let p = docContents.get(id);
  if (!p) {
    p = api<DocResponse>('GET', `/api/docs/${encodeURIComponent(id)}`);
    p.catch(() => docContents.delete(id));
    docContents.set(id, p);
  }
  return p;
}

export async function setDocStatus(id: string, status: DocStatus): Promise<void> {
  const doc = await api<DocSummary>('POST', `/api/docs/${encodeURIComponent(id)}/status`, { status });
  // Only into a loaded list: a list made of this one doc would hide all the others.
  set((s) => (s.docs ? { docs: { ...s.docs, [doc.id]: doc } } : {}));
}

/** With `thread`, archiving takes every version in the doc's thread (the conductor picks them). */
export async function setDocArchived(id: string, archived: boolean, thread = false): Promise<void> {
  const doc = await api<DocSummary>('POST', `/api/docs/${encodeURIComponent(id)}/archive`, { archived, ...(thread && { thread }) });
  set((s) => (s.docs ? { docs: { ...s.docs, [doc.id]: doc } } : {}));
}

export function setDocsFilter(docsFilter: DocsFilter): void {
  set({ docsFilter });
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

const attachmentBlobs = new Map<string, Promise<Blob>>();
/** An attached image's bytes, fetched from the conductor with the app token (cached). */
function attachmentBlob(threadId: string, file: string): Promise<Blob> {
  const key = `${threadId}/${file}`;
  let p = attachmentBlobs.get(key);
  if (!p) {
    p = (async () => {
      if (!conn) throw new Error('Not connected to the conductor');
      const res = await fetch(`${conn.url}/api/attachments/${encodeURIComponent(threadId)}/${encodeURIComponent(file)}`, {
        headers: { authorization: `Bearer ${conn.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })();
    p.catch(() => attachmentBlobs.delete(key));
    attachmentBlobs.set(key, p);
  }
  return p;
}

const attachmentUrls = new Map<string, Promise<string>>();
/** An attached image as a blob: URL, for the app's own <img> tags (cached). */
export function attachmentUrl(threadId: string, file: string): Promise<string> {
  const key = `${threadId}/${file}`;
  let p = attachmentUrls.get(key);
  if (!p) {
    p = attachmentBlob(threadId, file).then((blob) => URL.createObjectURL(blob));
    p.catch(() => attachmentUrls.delete(key));
    attachmentUrls.set(key, p);
  }
  return p;
}

const brandFontLoads = new Map<string, Promise<string | null>>();
/**
 * Loads a team font into the app and resolves with the CSS family to use, or null when the
 * team has none for this role. Registered under a Crew name so it never clashes with app fonts.
 */
export function loadBrandFont(font: BrandFont): Promise<string | null> {
  const family = `crew-brand-${font.role}`;
  const key = `${font.role}/${font.family}/${font.weight ?? ''}/${font.style ?? ''}`;
  let p = brandFontLoads.get(key);
  if (!p) {
    p = (async () => {
      if (!conn) throw new Error('Not connected to the conductor');
      const res = await fetch(`${conn.url}/api/brand-fonts/${font.role}`, { headers: { authorization: `Bearer ${conn.token}` } });
      if (!res.ok) return null;
      const face = new FontFace(family, await res.arrayBuffer(), {
        weight: String(font.weight ?? 400),
        style: font.style ?? 'normal',
      });
      document.fonts.add(await face.load());
      return family;
    })();
    p.catch(() => brandFontLoads.delete(key));
    brandFontLoads.set(key, p);
  }
  return p;
}

const attachmentDataUrls = new Map<string, Promise<string>>();
/**
 * A thread image as a data: URL, for HTML documents. They render in a sandboxed frame with
 * no origin of its own, which cannot load the app's blob: URLs.
 */
export function attachmentDataUrl(threadId: string, file: string): Promise<string> {
  const key = `${threadId}/${file}`;
  let p = attachmentDataUrls.get(key);
  if (!p) {
    // Straight from the bytes: the app's CSP has no blob: in connect-src, so fetch() on a blob: URL fails.
    p = attachmentBlob(threadId, file).then(
      (blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'));
          reader.readAsDataURL(blob);
        }),
    );
    p.catch(() => attachmentDataUrls.delete(key));
    attachmentDataUrls.set(key, p);
  }
  return p;
}

/** `benched`: specialists switched off for this thread; the lead cannot call them. */
export async function createThread(text: string, role?: string, files?: File[], benched: string[] = []): Promise<void> {
  const t = await api<Thread>('POST', '/api/threads', { text, role, attachments: await toUploads(files), benched });
  set((s) => ({ threads: { ...s.threads, [t.id]: t } }));
  navigate({ name: 'thread', threadId: t.id });
}

/** `replyTo`: the Inbox question this answers; only that question is resolved. */
export async function sendMessage(
  threadId: string,
  text: string,
  sessionId?: string,
  replyTo?: string,
  files?: File[],
  people: { mentions?: string[]; toAgent?: boolean } = {},
): Promise<void> {
  await api('POST', `/api/threads/${threadId}/messages`, { text, sessionId, replyTo, attachments: await toUploads(files), ...people });
}

/** Starts (or reopens) a direct message with these people, and opens it. */
export async function createDm(withEmails: string[], text?: string): Promise<void> {
  const thread = await api<Thread>('POST', '/api/dms', { with: withEmails, text });
  set((s) => ({ threads: { ...s.threads, [thread.id]: thread } }));
  navigate({ name: 'thread', threadId: thread.id });
}

/** A DM's name for whoever looks at it: the other people in it. */
export function dmTitle(thread: Thread, me: string | null = state.me, people: Person[] = state.people): string {
  const others = (thread.people ?? []).filter((p) => p !== me);
  return others.length ? others.map((e) => personName(e, people)).join(', ') : thread.title;
}

/** A DM was looked at: its unread dot goes. */
export function markDmSeen(threadId: string): void {
  const at = Math.max(Date.now(), state.threads[threadId]?.updatedAt ?? 0);
  if ((state.dmSeen[threadId] ?? 0) >= at) return;
  const dmSeen = { ...state.dmSeen, [threadId]: at };
  set({ dmSeen });
  try {
    localStorage.setItem(DM_SEEN_KEY, JSON.stringify(dmSeen));
  } catch {
    /* storage unavailable: unread lasts for this session */
  }
}

/** Tells the conductor which thread I have open (none while the app is in the background). Team server only. */
function sendPresence(typing = false): void {
  if (!state.me || !ws || ws.readyState !== WebSocket.OPEN) return;
  const threadId = state.view.name === 'thread' && document.visibilityState === 'visible' ? state.view.threadId : null;
  ws.send(JSON.stringify({ kind: 'presence', threadId, ...(typing ? { typing: true } : {}) } satisfies ClientMessage));
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => sendPresence());

let lastTyping = 0;
/** I am typing in the open thread: said at most every 2 seconds; it stops on its own. */
export function sendTyping(): void {
  if (Date.now() - lastTyping < 2000) return;
  lastTyping = Date.now();
  sendPresence(true);
}

/** Go ahead: the agent stops waiting for the people it held off for. */
export async function releaseThread(threadId: string): Promise<void> {
  await api('POST', `/api/threads/${threadId}/release`);
}

/** The people (by email) a message tags: "@Juliette" for each colleague, not yourself. */
export function mentionedPeople(text: string, people: Person[] = state.people, me: string | null = state.me): string[] {
  const out: string[] = [];
  for (const p of people) {
    if (p.email === me) continue;
    const re = new RegExp(`(^|[^\\w@])@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i');
    if (re.test(text)) out.push(p.email);
  }
  return out;
}

/** Whether an Inbox item is for whoever is signed in: tags are only for the person tagged. */
export function forMe(item: InboxItem, me: string | null = state.me): boolean {
  return item.kind !== 'mention' || !me || item.for === me;
}

/** Change a queued message before the agent has it. */
export async function editQueuedMessage(messageId: number, text: string): Promise<void> {
  await api('POST', `/api/messages/${messageId}/edit`, { text });
}

/** Take back a queued message before the agent has it. */
export async function removeQueuedMessage(messageId: number): Promise<void> {
  await api('POST', `/api/messages/${messageId}/remove`);
}

/**
 * Open New thread with this thread's first question and team, to try it again
 * with other specialists switched off. Attached images are not carried over.
 */
export function runAgain(threadId: string): void {
  const thread = state.threads[threadId] ?? state.done[threadId];
  const detail = state.details[threadId];
  if (!thread || !detail) return;
  const root = detail.sessions[thread.rootSessionId];
  const first = detail.events.find((e) => e.type === 'message' && e.role === 'user' && e.sessionId === thread.rootSessionId);
  set({ newDraft: { text: first?.type === 'message' ? first.text : thread.title, role: root?.role, benched: thread.benched ?? [] } });
  navigate({ name: 'new', role: root?.role });
}

/** The New thread screen takes its draft once. */
export function takeNewDraft(): NewThreadDraft | null {
  const d = state.newDraft;
  if (d) set({ newDraft: null });
  return d;
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

/** Shares the thread read-only, or updates the link's snapshot to the thread as it is now. */
export async function shareThread(threadId: string): Promise<ThreadShare> {
  const { share } = await api<{ share: ThreadShare }>('POST', `/api/threads/${threadId}/share`);
  set((s) => ({ shares: { ...s.shares, [threadId]: share } }));
  return share;
}

/** Stops sharing: the link stops working. */
export async function unshareThread(threadId: string): Promise<void> {
  await api('POST', `/api/threads/${threadId}/unshare`);
  set((s) => ({ shares: { ...s.shares, [threadId]: null } }));
}

export async function archiveThread(threadId: string): Promise<void> {
  await api('POST', `/api/threads/${threadId}/archive`);
  if (state.view.name === 'thread' && state.view.threadId === threadId) navigate({ name: 'threads' });
}

export async function resolveInbox(id: string): Promise<void> {
  await api('POST', `/api/inbox/${id}/resolve`);
}

/** Merge a Developer's pull request on GitHub; the item leaves the Inbox. */
export async function mergePullRequest(id: string): Promise<void> {
  await api('POST', `/api/inbox/${id}/merge`);
}

/** `always`: also allow this agent's tool ('tool') or every tool ('all') for the rest of the thread. */
export async function decideApproval(id: string, approved: boolean, always?: 'tool' | 'all'): Promise<void> {
  const action = !approved ? 'deny' : always === 'tool' ? 'allow' : always === 'all' ? 'allow-all' : 'approve';
  await api('POST', `/api/inbox/${id}/${action}`);
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

/** Opens a web link in a browser tab of the open thread's preview panel, or in the system browser. */
export function openUrl(url: string): void {
  const view = state.view;
  // The browser tab in the preview is Electron's <webview>; the web app opens a real tab.
  if (view.name !== 'thread' || !window.crewHost) {
    openExternal(url);
    return;
  }
  let title = url;
  try {
    title = new URL(url).hostname.replace(/^www\./, '');
  } catch {}
  openAsPreview(view.threadId, { id: `web-${Date.now()}`, title, format: 'web', content: url, from: '', ts: Date.now() });
}

/** A browser tab moved to another page or got its title; keeps its place in the tab order. */
export function updateWebPreview(threadId: string, id: string, patch: { title?: string; content?: string }): void {
  set((s) => ({
    extraPreviews: {
      ...s.extraPreviews,
      [threadId]: (s.extraPreviews[threadId] ?? []).map((d) => (d.id === id ? { ...d, ...patch } : d)),
    },
  }));
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
    const r = await api<ServerLogin | { ok: true }>('POST', `/api/connections/${encodeURIComponent(id)}/sign-in`);
    // On a server the sign-in runs there; follow it in the app.
    if ('id' in r) {
      stopWaiting([id]);
      followServerLogin(r);
      return;
    }
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

// ---------------------------------------------------------------------------
// A sign-in running on the server

let loginPoll: number | undefined;
const opened = new Set<string>();
const relayed = new Set<string>();

function followServerLogin(login: ServerLogin): void {
  set({ serverLogin: login, serverLoginError: null });
  window.clearInterval(loginPoll);
  const step = async () => {
    const cur = state.serverLogin;
    if (!cur) return window.clearInterval(loginPoll);
    let next: ServerLogin;
    try {
      next = await api<ServerLogin>('GET', `/api/logins/${encodeURIComponent(cur.id)}`);
    } catch (err) {
      set({ serverLoginError: (err as Error).message });
      return;
    }
    // A browser sign-in that returns to 127.0.0.1: catch it here, pass it on.
    if (next.callbackPort && !relayed.has(next.id)) {
      relayed.add(next.id);
      const err = await window.crewHost?.loginRelay?.(next.callbackPort, next.id);
      if (err) set({ serverLoginError: err });
    }
    if (next.url && !opened.has(next.id)) {
      opened.add(next.id);
      openExternal(next.url);
    }
    set({ serverLogin: next });
    if (next.done) {
      window.clearInterval(loginPoll);
      void loadConnections(true);
    }
  };
  void step();
  loginPoll = window.setInterval(() => void step(), 1500);
}

export async function sendLoginCode(text: string): Promise<void> {
  const cur = state.serverLogin;
  if (!cur) return;
  try {
    await api('POST', `/api/logins/${encodeURIComponent(cur.id)}/input`, { text });
    set({ serverLoginError: null });
  } catch (err) {
    set({ serverLoginError: (err as Error).message });
  }
}

export function closeServerLogin(): void {
  const cur = state.serverLogin;
  window.clearInterval(loginPoll);
  if (cur && !cur.done) void api('POST', `/api/logins/${encodeURIComponent(cur.id)}/cancel`).catch(() => undefined);
  set({ serverLogin: null, serverLoginError: null });
  void loadConnections(true);
}

// Coming back from Terminal or the browser: check again, past the cache.
window.addEventListener('focus', () => {
  if (state.connection === 'online') void loadConnections(true);
});
