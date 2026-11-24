// Local HTTP API and WebSocket. Binds to 127.0.0.1 only. Every request needs
// the app token from ~/.crew/conductor.json; bridge calls use a per-session
// token instead.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CreateThreadRequest, SendMessageRequest, ServerMessage } from '@crew/protocol';
import type { AccessIdentity } from './access.ts';
import { UpdateInProgress, type Runtime } from './runtime.ts';
import { connections, signIn } from './connections.ts';

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

export function startServer(runtime: Runtime, opts: { port: number; token: string; identity?: AccessIdentity }) {
  const server = createServer(async (req, res) => {
    corsHeaders(res);
    if (req.method === 'OPTIONS' && !opts.identity) {
      res.writeHead(204).end();
      return;
    }
    const url = URL.parse(req.url ?? '/', 'http://localhost');
    if (!url) return send(res, 400, { error: 'Invalid request URL' });
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

      // HTTP takes the token only as a header; the ?token= form is for the WebSocket alone.
      const auth = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (!sameToken(auth, opts.token)) {
        res.setHeader('www-authenticate', 'Bearer realm="Crew"');
        return send(res, 401, { error: 'Unauthorized' });
      }
      const user = await opts.identity?.(req.headers['cf-access-jwt-assertion']);
      const byEmail = user?.email ?? null;
      if (opts.identity && !byEmail) return send(res, 401, { error: 'Invalid Access identity' });
      if (req.method === 'OPTIONS') return res.writeHead(204).end();

      if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' });
      const [, a, id, action] = parts;

      if (req.method === 'GET' && a === 'state') return send(res, 200, await runtime.state());
      if (req.method === 'GET' && (a === 'agents' || a === 'roles')) return send(res, 200, await runtime.roles());

      if (a === 'connections') {
        if (req.method === 'GET' && !id) {
          const items = await connections(url.searchParams.has('refresh'));
          return send(res, 200, opts.identity ? items.map(item => ({ ...item, canSignIn: false })) : items);
        }
        if (req.method === 'POST' && id && action === 'sign-in') {
          if (opts.identity) return send(res, 409, { error: 'The server admin manages engine sign-ins.' });
          await signIn(id);
          return send(res, 200, { ok: true });
        }
      }

      if (a === 'threads') {
        if (req.method === 'POST' && !id) {
          const body = await readJson<CreateThreadRequest>(req);
          if (!body.text?.trim() && !body.attachments?.length) return send(res, 400, { error: 'text or an image is required' });
          return send(res, 200, await runtime.createThread(body.text, body.role, body.attachments, Array.isArray(body.benched) ? body.benched.map(String) : [], byEmail));
        }
        if (req.method === 'GET' && id && !action) {
          const detail = runtime.threadDetail(id);
          return detail ? send(res, 200, detail) : send(res, 404, { error: 'No such thread' });
        }
        if (req.method === 'POST' && id && action === 'messages') {
          const body = await readJson<SendMessageRequest>(req);
          if (!body.text?.trim() && !body.attachments?.length) return send(res, 400, { error: 'text or an image is required' });
          return send(res, 200, runtime.sendMessage(id, body.text, body.sessionId, body.replyTo, body.attachments, byEmail));
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
        return send(res, 200, runtime.resolveInbox(id, byEmail) ?? { error: 'No such item' });
      }
      if (a === 'inbox' && id && (action === 'approve' || action === 'deny') && req.method === 'POST') {
        return send(res, 200, runtime.decideApproval(id, action === 'approve', byEmail));
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof UpdateInProgress) return send(res, 503, { error: err.message });
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
    socket.on('error', () => socket.destroy());
    const url = URL.parse(req.url ?? '/', 'http://localhost');
    if (url?.pathname !== '/ws' || !sameToken(url.searchParams.get('token') ?? '', opts.token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm="Crew"\r\nConnection: close\r\n\r\n');
      return;
    }
    const user = await opts.identity?.(req.headers['cf-access-jwt-assertion']);
    if (opts.identity && !user) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify({ kind: 'hello', version: 1 } satisfies ServerMessage));
      const expiry = user && setTimeout(() => ws.close(1008, 'Access session expired'), Math.min(2_147_483_647, Math.max(1, user.expiresAt - Date.now()))).unref();
      ws.on('close', () => { if (expiry) clearTimeout(expiry); clients.delete(ws); });
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
