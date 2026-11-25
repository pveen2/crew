// Local HTTP API and WebSocket. Binds to 127.0.0.1 only. Every request needs
// the app token from ~/.crew/conductor.json; bridge calls use a per-session
// token instead.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, CreateThreadRequest, SendMessageRequest, ServerMessage } from '@crew/protocol';
import type { Runtime } from './runtime.ts';
import { connections, signIn } from './connections.ts';
import { accessEmail, accessEnabled } from './access.ts';
import { cancelLogin, loginInput, loginState } from './server-login.ts';
import { PUBLIC_WEB_FILES, serveWeb } from './web.ts';

/** A conductor on a (Linux) server rather than someone's Mac. */
const onServer = process.platform !== 'darwin';
/** CREW_ADMINS: who may sign tools in on a server (comma-separated emails). */
const admins = new Set((process.env.CREW_ADMINS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
const isAdmin = (email: string | null) => Boolean(email && admins.has(email.toLowerCase()));

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    // Room for a few attached images (base64).
    if (data.length > 60_000_000) throw new Error('Request too large');
  }
  return (data ? JSON.parse(data) : {}) as T;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The thread a socket message is about, if any. */
function threadOf(msg: ServerMessage): string | null {
  switch (msg.kind) {
    case 'event':
      return msg.event.threadId;
    case 'thread':
      return msg.thread.id;
    case 'session':
      return msg.session.threadId;
    case 'turn':
      return msg.turn.threadId;
    case 'inbox':
      return msg.item.threadId;
    case 'doc':
      return msg.doc.threadId;
    case 'presence':
      return msg.threadId;
    default:
      return null;
  }
}

/** A share token: 32 random bytes, base64url. */
const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * CREW_PUBLIC_URL: the server's public address (https://crew.example.com), for share
 * links. Only https; a path or anything after the host is dropped.
 */
const PUBLIC_ORIGIN = (() => {
  const raw = process.env.CREW_PUBLIC_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('CREW_PUBLIC_URL must start with https://');
  return url.origin;
})();

/**
 * The public link for a share token: on CREW_PUBLIC_URL, otherwise on the Host the
 * request came in on (behind the Cloudflare tunnel, the app's hostname). Always
 * https, and never from X-Forwarded-Host, which the caller controls.
 */
function shareUrl(req: IncomingMessage, token: string): string {
  if (PUBLIC_ORIGIN) return `${PUBLIC_ORIGIN}/s/${token}`;
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) throw new Error('Set CREW_PUBLIC_URL to make share links.');
  return `https://${host}/s/${token}`;
}

function corsHeaders(res: ServerResponse): void {
  // The app renderer may be served from the Vite dev server in development.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

export function startServer(runtime: Runtime, opts: { port: number; token: string }) {
  // Threads from before people were recorded were the first admin's: Crew had one person then.
  const firstAdmin = [...admins][0];
  if (accessEnabled && firstAdmin) {
    const claimed = runtime.claimUnownedThreads(firstAdmin);
    if (claimed) console.log(`[people] ${claimed} earlier thread(s) now belong to ${firstAdmin}`);
  }

  const server = createServer(async (req, res) => {
    corsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      // Calls from the MCP bridge inside an agent session.
      if (url.pathname === '/internal/tool' && req.method === 'POST') {
        const body = await readJson<{ sessionId: string; tool: string; args: Record<string, unknown> }>(req);
        const token = String(req.headers['x-crew-bridge'] ?? '');
        if (!body.sessionId || !runtime.checkBridgeToken(body.sessionId, token)) return send(res, 401, { error: 'Unauthorized' });
        // If the agent process goes away while a specialist or an approval is waiting, stop waiting.
        const gone = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) gone.abort();
        });
        try {
          const text = await runtime.handleTool(body.sessionId, body.tool, body.args ?? {}, gone.signal);
          return send(res, 200, { text });
        } catch (err) {
          return send(res, 200, { error: (err as Error).message });
        }
      }

      // App sign-in through the person's own browser (behind Cloudflare Access):
      // hand the Access login to the app waiting on this Mac, and only there.
      if (url.pathname === '/auth/app-login' && req.method === 'GET') {
        if (!accessEnabled) return send(res, 404, { error: 'Not found' });
        if (!(await accessEmail(req))) return send(res, 401, { error: 'Sign in through Cloudflare Access' });
        const appPort = Number(url.searchParams.get('port'));
        const state = url.searchParams.get('state') ?? '';
        if (!Number.isInteger(appPort) || appPort < 1024 || appPort > 65535 || !/^[A-Za-z0-9_-]{32,128}$/.test(state)) {
          return send(res, 400, { error: 'Bad sign-in request' });
        }
        const jwt = String(req.headers['cf-access-jwt-assertion']);
        const back = `http://127.0.0.1:${appPort}/callback?state=${state}&token=${encodeURIComponent(jwt)}`;
        res.writeHead(302, { location: back, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        res.end();
        return;
      }

      // The home screen icons and manifest are public: after "Add to Home Screen"
      // iOS fetches the icon again without the Access cookie and, refused, saves a
      // blurry screenshot instead. Cloudflare Access bypasses these paths too.
      if (accessEnabled && req.method === 'GET' && PUBLIC_WEB_FILES.has(url.pathname)) {
        if (await serveWeb(url.pathname, res, { fallback: false })) return;
        return send(res, 404, { error: 'Not found' });
      }

      // Share links (/s/<token>) are public: anyone with the link sees a read-only
      // snapshot of one thread, without signing in. Cloudflare Access bypasses /s/*.
      // /s/assets/* is the app's code (the share page is the same app); no data.
      if (accessEnabled && req.method === 'GET' && parts[0] === 's') {
        res.setHeader('x-robots-tag', 'noindex, nofollow');
        res.setHeader('referrer-policy', 'no-referrer');
        if (parts[1] === 'assets' && parts.length === 3) {
          if (await serveWeb(`/assets/${parts[2]}`, res, { fallback: false })) return;
          return send(res, 404, { error: 'Not found' });
        }
        const token = parts[1] ?? '';
        if (!SHARE_TOKEN.test(token)) return send(res, 404, { error: 'Not found' });
        // /s/<token>/ would load the page's code from /s/<token>/assets: send it to /s/<token>.
        if (parts.length === 2 && url.pathname.endsWith('/')) {
          res.writeHead(301, { location: `/s/${token}`, 'cache-control': 'no-store' });
          res.end();
          return;
        }
        if (parts.length === 2) {
          if (await serveWeb('/index.html', res, { fallback: false })) return;
          return send(res, 404, { error: 'Not found' });
        }
        if (parts.length === 3 && parts[2] === 'data') {
          const shared = runtime.sharedSnapshot(token);
          res.setHeader('cache-control', 'no-store');
          return shared ? send(res, 200, shared) : send(res, 404, { error: 'This link does not work any more.' });
        }
        if (parts.length === 4 && parts[2] === 'files') {
          const file = runtime.sharedFile(token, parts[3]!);
          if (!file) return send(res, 404, { error: 'Not found' });
          res.writeHead(200, { 'content-type': file.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          res.end(file.data);
          return;
        }
        return send(res, 404, { error: 'Not found' });
      }

      // HTTP takes the token only as a header; the ?token= form is for the WebSocket alone.
      // Behind Cloudflare Access the person's Access login is what counts; the app
      // token is only needed without it (a conductor on a Mac).
      let email: string | null = null;
      if (accessEnabled) {
        email = await accessEmail(req);
        if (!email) return send(res, 401, { error: 'Sign in through Cloudflare Access' });
        email = email.toLowerCase();
        runtime.touchPerson(email);
      } else {
        const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!sameToken(auth, opts.token)) return send(res, 401, { error: 'Unauthorized' });
      }

      if (parts[0] !== 'api') {
        // Behind Access the conductor also serves the app itself, for phones.
        if (accessEnabled && req.method === 'GET' && (await serveWeb(url.pathname, res))) return;
        return send(res, 404, { error: 'Not found' });
      }
      const [, a, id, action] = parts;

      if (req.method === 'GET' && a === 'state') return send(res, 200, { ...(await runtime.stateFor(email)), sharing: accessEnabled, me: email, people: accessEnabled ? runtime.people() : [] });
      if (req.method === 'GET' && (a === 'agents' || a === 'roles')) return send(res, 200, await runtime.roles());
      if (req.method === 'GET' && a === 'spend') {
        const days = Math.min(366, Math.max(1, Math.round(Number(url.searchParams.get('days') ?? 30)) || 30));
        const tz = Number(url.searchParams.get('tz') ?? 0);
        return send(res, 200, runtime.spend(days, Number.isFinite(tz) && Math.abs(tz) <= 840 ? Math.round(tz) : 0));
      }

      // On a server only admins sign tools in, for the whole team.
      const mayManage = !onServer || isAdmin(email);
      if (a === 'connections') {
        if (req.method === 'GET' && !id) {
          const list = await connections(url.searchParams.has('refresh'));
          return send(res, 200, mayManage ? list : list.map((c) => ({ ...c, canSignIn: false })));
        }
        if (req.method === 'POST' && id && action === 'sign-in') {
          if (!mayManage) return send(res, 403, { error: 'Only the server admin signs tools in, for the whole team.' });
          const login = await signIn(id);
          return send(res, 200, login ?? { ok: true });
        }
      }

      // A sign-in running on the server: /api/logins/<id>, …/input, …/cancel
      if (a === 'logins' && id) {
        if (!mayManage) return send(res, 403, { error: 'Only the server admin signs tools in.' });
        if (req.method === 'GET' && !action) return send(res, 200, loginState(id) ?? { error: 'No such sign-in' });
        if (req.method === 'POST' && action === 'input') {
          const body = await readJson<{ text?: string }>(req);
          await loginInput(id, String(body.text ?? ''));
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && action === 'cancel') {
          cancelLogin(id);
          return send(res, 200, { ok: true });
        }
      }

      // A direct message (team server): POST /api/dms { with: [emails], text? }
      if (a === 'dms' && !id && req.method === 'POST') {
        if (!accessEnabled || !email) return send(res, 404, { error: 'Direct messages need a team server.' });
        const body = await readJson<{ with?: unknown; text?: unknown }>(req);
        const others = Array.isArray(body.with) ? body.with.map(String) : [];
        return send(res, 200, await runtime.createDm(email, others, typeof body.text === 'string' ? body.text : undefined));
      }

      // A DM is only for the people in it: to anyone else it, and everything in it, does not exist.
      if (id && email) {
        const kinds = { messages: 'message', sessions: 'session', inbox: 'inbox', docs: 'doc' } as const;
        const kind = kinds[a as keyof typeof kinds];
        const threadId = a === 'threads' || a === 'attachments' ? id : kind ? runtime.threadOf(kind, id) : undefined;
        if (threadId && !runtime.canSee(threadId, email)) return send(res, 404, { error: 'Not found' });
      }

      if (a === 'threads') {
        if (req.method === 'POST' && !id) {
          const body = await readJson<CreateThreadRequest>(req);
          if (!body.text?.trim() && !body.attachments?.length) return send(res, 400, { error: 'text or an image is required' });
          return send(res, 200, await runtime.createThread(body.text, body.role, body.attachments, Array.isArray(body.benched) ? body.benched.map(String) : [], email));
        }
        if (req.method === 'GET' && id && !action) {
          const detail = runtime.threadDetail(id);
          if (!detail) return send(res, 404, { error: 'No such thread' });
          const share = accessEnabled ? runtime.shareOf(id) : undefined;
          return send(res, 200, { ...detail, share: share ? { url: shareUrl(req, share.token), sharedAt: share.sharedAt } : null });
        }
        // Share links, on a team server only: share (or update the snapshot), and stop sharing.
        if (req.method === 'POST' && id && (action === 'share' || action === 'unshare')) {
          if (!accessEnabled) return send(res, 404, { error: 'Share links need a team server.' });
          if (runtime.threadDetail(id)?.thread.dm) return send(res, 400, { error: 'Direct messages cannot be shared.' });
          if (!runtime.threadDetail(id)) return send(res, 404, { error: 'No such thread' });
          if (action === 'unshare') {
            runtime.unshareThread(id);
            return send(res, 200, { share: null });
          }
          const share = await runtime.shareThread(id, email);
          return send(res, 200, { share: { url: shareUrl(req, share.token), sharedAt: share.sharedAt } });
        }
        if (req.method === 'POST' && id && action === 'messages') {
          const body = await readJson<SendMessageRequest>(req);
          if (!body.text?.trim() && !body.attachments?.length) return send(res, 400, { error: 'text or an image is required' });
          return send(
            res,
            200,
            runtime.sendMessage(id, body.text, body.sessionId, body.replyTo, body.attachments, email, {
              mentions: accessEnabled && Array.isArray(body.mentions) ? body.mentions.map(String) : [],
              toAgent: body.toAgent === true,
            }),
          );
        }
        // Go ahead: the agent stops waiting for the people it held off for.
        if (req.method === 'POST' && id && action === 'release') {
          return send(res, 200, runtime.releaseHeld(id, email));
        }
        if (req.method === 'POST' && id && action === 'resume') {
          runtime.resumeThread(id);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && id && action === 'archive') {
          runtime.archiveThread(id);
          return send(res, 200, { ok: true });
        }
      }

      // An attached image, for the app: /api/attachments/<threadId>/<file>
      if (a === 'attachments' && id && action && req.method === 'GET') {
        const file = runtime.attachmentFile(id, action);
        if (!file) return send(res, 404, { error: 'No such attachment' });
        res.writeHead(200, { 'content-type': file.mime, 'cache-control': 'private, max-age=31536000, immutable' });
        res.end(file.data);
        return;
      }

      // Docs (the Docs tab): GET /api/docs, GET /api/docs/<id>, POST /api/docs/<id>/status, POST /api/docs/<id>/archive
      if (a === 'docs') {
        if (req.method === 'GET' && !id) return send(res, 200, runtime.docs().filter((d) => runtime.canSee(d.threadId, email)));
        if (req.method === 'GET' && id && !action) {
          const doc = runtime.doc(id);
          return doc && runtime.canSee(doc.threadId, email) ? send(res, 200, doc) : send(res, 404, { error: 'No such doc' });
        }
        if (req.method === 'POST' && id && action === 'status') {
          const body = await readJson<unknown>(req);
          const status = body && typeof body === 'object' ? (body as { status?: unknown }).status : undefined;
          if (status !== 'draft' && status !== 'approved') return send(res, 400, { error: 'status must be draft or approved' });
          if (!runtime.doc(id)) return send(res, 404, { error: 'No such doc' });
          return send(res, 200, runtime.setDocStatus(id, status));
        }
        if (req.method === 'POST' && id && action === 'archive') {
          const body = await readJson<unknown>(req);
          const archived = body && typeof body === 'object' ? (body as { archived?: unknown }).archived : undefined;
          if (typeof archived !== 'boolean') return send(res, 400, { error: 'archived must be true or false' });
          if (!runtime.doc(id)) return send(res, 404, { error: 'No such doc' });
          const thread = (body as { thread?: unknown }).thread === true;
          return send(res, 200, runtime.setDocArchived(id, archived, thread));
        }
      }

      // A team font, for concept boards: /api/brand-fonts/<role>
      if (a === 'brand-fonts' && id && req.method === 'GET') {
        const file = await runtime.brandFontFile(id);
        if (!file) return send(res, 404, { error: 'No such font' });
        res.writeHead(200, { 'content-type': file.mime, 'cache-control': 'private, max-age=300' });
        res.end(file.data);
        return;
      }

      // A queued owner message, before the agent has it: /api/messages/<eventId>/edit or /remove
      if (a === 'messages' && id && req.method === 'POST') {
        if (action === 'edit') {
          const body = await readJson<{ text?: string }>(req);
          runtime.editQueuedMessage(Number(id), String(body.text ?? ''));
          return send(res, 200, { ok: true });
        }
        if (action === 'remove') {
          runtime.removeQueuedMessage(Number(id));
          return send(res, 200, { ok: true });
        }
      }

      if (a === 'sessions' && id && req.method === 'POST') {
        if (action === 'resume') {
          runtime.resumeSession(id);
          return send(res, 200, { ok: true });
        }
        if (action === 'stop') {
          runtime.stopSession(id);
          return send(res, 200, { ok: true });
        }
      }

      if (a === 'inbox' && id && action === 'resolve' && req.method === 'POST') {
        return send(res, 200, runtime.resolveInbox(id) ?? { error: 'No such item' });
      }
      if (a === 'inbox' && id && action === 'merge' && req.method === 'POST') {
        return send(res, 200, await runtime.mergePullRequest(id));
      }
      if (a === 'inbox' && id && ['approve', 'allow', 'allow-all', 'deny'].includes(action) && req.method === 'POST') {
        const always = action === 'allow' ? 'tool' : action === 'allow-all' ? 'all' : undefined;
        return send(res, 200, runtime.decideApproval(id, action !== 'deny', always));
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[server]', err);
      return send(res, 500, { error: (err as Error).message });
    }
  });

  // Subagent calls and approvals can keep a request open for a long time.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  const wss = new WebSocketServer({ noServer: true });
  /** Each connection and who it is (null without Access: one person). */
  const clients = new Map<WebSocket, string | null>();

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const who = accessEnabled ? ((await accessEmail(req))?.toLowerCase() ?? null) : null;
    if (url.pathname !== '/ws' || (accessEnabled ? !who : !sameToken(url.searchParams.get('token') ?? '', opts.token))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, who);
      ws.on('message', (data) => {
        if (!who) return;
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(data)) as ClientMessage;
        } catch {
          return;
        }
        if (msg?.kind !== 'presence') return;
        const threadId = typeof msg.threadId === 'string' && runtime.canSee(msg.threadId, who) ? msg.threadId : null;
        const before = presence.get(ws)?.threadId ?? null;
        presence.set(ws, { threadId, typingUntil: threadId && msg.typing ? Date.now() + TYPING_MS : 0 });
        if (before && before !== threadId) sendPresence(before);
        if (threadId) sendPresence(threadId);
      });
      ws.send(JSON.stringify({ kind: 'hello', version: 1 } satisfies ServerMessage));
      const gone = () => {
        clients.delete(ws);
        const was = presence.get(ws)?.threadId;
        presence.delete(ws);
        if (was) sendPresence(was);
      };
      ws.on('close', gone);
      ws.on('error', gone);
    });
  });

  // Presence (team server): which thread each connection has open, and whether its person is typing.
  const TYPING_MS = 5000;
  const presence = new Map<WebSocket, { threadId: string | null; typingUntil: number }>();
  const sendPresence = (threadId: string) => {
    const now = Date.now();
    const viewing = new Set<string>();
    const typing = new Set<string>();
    for (const [ws, p] of presence) {
      const who = clients.get(ws);
      if (!who || p.threadId !== threadId) continue;
      viewing.add(who);
      if (p.typingUntil > now) typing.add(who);
    }
    broadcast({ kind: 'presence', threadId, viewing: [...viewing], typing: [...typing] });
  };
  // Typing stops on its own when the app stops saying so.
  const typingTimer = setInterval(() => {
    const now = Date.now();
    const ended = new Set<string>();
    for (const p of presence.values()) {
      if (p.typingUntil && p.typingUntil <= now) {
        p.typingUntil = 0;
        if (p.threadId) ended.add(p.threadId);
      }
    }
    for (const t of ended) sendPresence(t);
  }, 1000);
  typingTimer.unref();

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    const threadId = threadOf(msg);
    for (const [ws, who] of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      // DMs go only to the people in them.
      if (threadId && who && !runtime.canSee(threadId, who)) continue;
      ws.send(data);
    }
  };

  runtime.subscribe(broadcast);

  return new Promise<typeof server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve(server));
  });
}
