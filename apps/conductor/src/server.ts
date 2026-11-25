// Local HTTP API and WebSocket. Binds to 127.0.0.1 only. Every request needs
// the app token from ~/.crew/conductor.json; bridge calls use a per-session
// token instead.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CreateThreadRequest, SendMessageRequest, ServerMessage } from '@crew/protocol';
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

function corsHeaders(res: ServerResponse): void {
  // The app renderer may be served from the Vite dev server in development.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

export function startServer(runtime: Runtime, opts: { port: number; token: string }) {
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

      // HTTP takes the token only as a header; the ?token= form is for the WebSocket alone.
      // Behind Cloudflare Access the person's Access login is what counts; the app
      // token is only needed without it (a conductor on a Mac).
      let email: string | null = null;
      if (accessEnabled) {
        email = await accessEmail(req);
        if (!email) return send(res, 401, { error: 'Sign in through Cloudflare Access' });
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

      if (req.method === 'GET' && a === 'state') return send(res, 200, await runtime.state());
      if (req.method === 'GET' && (a === 'agents' || a === 'roles')) return send(res, 200, await runtime.roles());

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

      if (a === 'threads') {
        if (req.method === 'POST' && !id) {
          const body = await readJson<CreateThreadRequest>(req);
          if (!body.text?.trim() && !body.attachments?.length) return send(res, 400, { error: 'text or an image is required' });
          return send(res, 200, await runtime.createThread(body.text, body.role, body.attachments, Array.isArray(body.benched) ? body.benched.map(String) : []));
        }
        if (req.method === 'GET' && id && !action) {
          const detail = runtime.threadDetail(id);
          return detail ? send(res, 200, detail) : send(res, 404, { error: 'No such thread' });
        }
        if (req.method === 'POST' && id && action === 'messages') {
          const body = await readJson<SendMessageRequest>(req);
          if (!body.text?.trim() && !body.attachments?.length) return send(res, 400, { error: 'text or an image is required' });
          return send(res, 200, runtime.sendMessage(id, body.text, body.sessionId, body.replyTo, body.attachments));
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
        if (req.method === 'GET' && !id) return send(res, 200, runtime.docs());
        if (req.method === 'GET' && id && !action) {
          const doc = runtime.doc(id);
          return doc ? send(res, 200, doc) : send(res, 404, { error: 'No such doc' });
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
          return send(res, 200, runtime.setDocArchived(id, archived));
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
  const clients = new Set<WebSocket>();

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (
      url.pathname !== '/ws' ||
      (accessEnabled ? !(await accessEmail(req)) : !sameToken(url.searchParams.get('token') ?? '', opts.token))
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify({ kind: 'hello', version: 1 } satisfies ServerMessage));
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });

  runtime.subscribe((msg) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  });

  return new Promise<typeof server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve(server));
  });
}
