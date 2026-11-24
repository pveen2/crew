import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { accessIdentity } from '../src/access.ts';

test('HTTP and WebSocket require the app token and a signed user, including after key rotation', async t => {
  const home = mkdtempSync(join(tmpdir(), 'crew-access-'));
  process.env.CREW_HOME = home;
  const { ensureDirs, paths } = await import('../src/config.ts');
  const { Store } = await import('../src/db.ts');
  const { Runtime } = await import('../src/runtime.ts');
  const { startServer } = await import('../src/server.ts');
  ensureDirs();
  const store = new Store(paths.db);
  const runtime = new Runtime(store);
  // Exercise the real thread, message and approval paths without starting a paid CLI.
  t.mock.method(runtime, 'enqueueTurn', async () => {});
  const domain = 'crew-test.cloudflareaccess.com';
  const aud = 'test-app';
  const token = 'x'.repeat(36);
  const generate = kid => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid } };
  };
  const first = generate('first');
  const second = generate('second');
  let keys = [first.jwk];
  let fetches = 0;
  const request = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url !== 'https://' + domain + '/cdn-cgi/access/certs') return request(url, opts);
    fetches++;
    return Response.json({ keys });
  });
  const issuer = 'https://' + domain;
  const email = 'opener@example.test';
  function jwt(claims = {}, key = first, alg = 'RS256') {
    const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const data = encode({ kid: key.kid, alg }) + '.' + encode({ iss: issuer, aud: [aud], exp: Date.now() / 1000 + 600, email, ...claims });
    return data + '.' + sign('RSA-SHA256', Buffer.from(data), key.privateKey).toString('base64url');
  }
  assert.throws(() => accessIdentity(domain, ''));
  const server = await startServer(runtime, { port: 0, token, identity: accessIdentity(domain, aud) });
  t.after(async () => {
    await new Promise(done => server.close(done));
    store.db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const port = server.address().port;
  const api = (path, assertion, body, bearer = token) => request('http://127.0.0.1:' + port + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + bearer, ...(assertion ? { 'cf-access-jwt-assertion': assertion } : {}) },
    body: body && JSON.stringify(body),
  });
  async function upgrade(assertion, bearer = token) {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?token=' + bearer, { headers: assertion ? { 'cf-access-jwt-assertion': assertion } : {} });
    return new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
      ws.once('message', data => { ws.close(); resolve(JSON.parse(data).kind); });
    });
  }
  const good = jwt();
  for (const invalid of [undefined, 'malformed', jwt({ iss: 'wrong' }), jwt({ aud: ['other'] }), jwt({ exp: 1 }), jwt({ email: '' }), jwt({}, first, 'HS256'), good.replace(/\.[^.]+$/, '.AA')]) {
    assert.equal((await api('/api/state', invalid)).status, 401);
    assert.equal(await upgrade(invalid), 401);
  }
  assert.equal((await api('/api/state', good, null, 'wrong')).status, 401);
  assert.equal(await upgrade(good, 'wrong'), 401);
  assert.equal(await upgrade(good), 'hello');
  assert.equal((await api('/api/state', good)).status, 200);
  assert.equal(fetches, 1);

  const thread = await (await api('/api/threads', good, { text: 'First', byEmail: 'spoof' })).json();
  assert.equal(thread.byEmail, email);
  keys = [second.jwk];
  const colleague = 'colleague@example.test';
  const rotated = jwt({ email: colleague }, second);
  assert.equal((await api('/api/threads/' + thread.id + '/messages', rotated, { text: 'Second' })).status, 200);
  assert.equal(fetches, 2);
  const messages = store.eventsOfThread(thread.id).filter(e => e.type === 'message');
  assert.deepEqual(messages.map(e => e.byEmail), [email, colleague]);

  const session = store.session(thread.rootSessionId);
  t.mock.method(runtime, 'handleTool', async () => 'bridge ok');
  const bridge = bridgeToken => request('http://127.0.0.1:' + port + '/internal/tool', {
    method: 'POST', headers: { 'x-crew-bridge': bridgeToken },
    body: JSON.stringify({ sessionId: session.id, tool: 'test' }),
  });
  assert.equal((await bridge(token)).status, 401);
  assert.deepEqual(await (await bridge(runtime.bridgeToken(session.id))).json(), { text: 'bridge ok' });
  for (const action of ['approve', 'deny', 'resolve']) {
    const waiting = runtime.requireApproval(session, { def: {}, label: 'Test' }, 'sample', {}, 'user-approval', new AbortController().signal);
    const result = waiting.then(() => true, () => false);
    const [item] = store.openInbox();
    const decision = await (await api('/api/inbox/' + item.id + '/' + action, rotated, {})).json();
    assert.equal(decision.byEmail, colleague);
    assert.equal(await result, action === 'approve');
    assert.equal(store.eventsOfThread(thread.id).find(e => e.type === 'approval_done' && e.inboxId === item.id)?.byEmail, colleague);
    await api('/api/inbox/' + item.id + '/resolve', jwt({ email }, second), {});
    assert.equal(store.inboxItem(item.id).byEmail, colleague);
  }
});
