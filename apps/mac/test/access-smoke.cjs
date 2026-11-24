// Run with the Electron binary after building the renderer. All network traffic stays on loopback.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { X509Certificate } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs');
const { createServer } = require('node:https');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocketServer } = require('ws');

const temp = mkdtempSync(join(tmpdir(), 'crew-electron-'));
app.setPath('userData', temp);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP crew.test 127.0.0.1');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('use-mock-keychain');
process.env.CREW_HOME = temp;
const token = 'test'.repeat(9);
const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
let logins = 0;
let auth;
let binding;
let upgrades = 0;
let snapshots = 0;
let failure = 0;
const rejectUpgrade = process.argv.includes('--reject-upgrade');
let rejected = false;
const state = { team: { name: 'Remote team', suggestions: [] }, threads: [], done: [], inbox: [], roles: [], activity: [] };

function checkHeaders(req) {
  assert.equal(req.headers['cf-access-token'], auth);
  assert.ok(req.headers.cookie?.includes('CF_Binding=' + binding));
  assert.ok(req.headers.cookie?.includes('CF_Authorization=' + auth));
}

async function until(check) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${check} (logins=${logins}, upgrades=${upgrades}, reads=${snapshots})`);
}

async function run() {
  const key = join(temp, 'tls.key');
  const cert = join(temp, 'tls.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=crew.test', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const pem = readFileSync(cert);
  const edge = createServer({ key: readFileSync(key), cert: pem }, (req, res) => {
    if (req.url === '/') {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers['cf-access-token'], undefined);
      logins++;
      auth = 'header.' + payload + '.' + logins;
      binding = 'bound' + logins;
      res.setHeader('Set-Cookie', [`CF_Authorization=${auth}; Secure; HttpOnly; Path=/`, `CF_Binding=${binding}; Secure; HttpOnly; Path=/`]);
      return res.end('Signed in');
    }
    if (!req.url.startsWith('/api/')) return res.writeHead(404).end();
    checkHeaders(req);
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (failure) {
      const code = failure;
      failure = 0;
      if (code === 302) res.setHeader('Location', 'https://never-contact.cloudflareaccess.com/login');
      return res.writeHead(code).end();
    }
    if (req.url === '/api/state') snapshots++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/state' ? state : []));
  });
  const wss = new WebSocketServer({ noServer: true });
  edge.on('upgrade', (req, socket, head) => {
    checkHeaders(req);
    assert.equal(req.url, '/ws?token=' + token);
    if (rejectUpgrade && !rejected) {
      rejected = true;
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
    wss.handleUpgrade(req, socket, head, ws => {
      upgrades++;
      ws.send(JSON.stringify({ kind: 'hello', version: 1 }));
    });
  });
  edge.listen(0, '127.0.0.1');
  await once(edge, 'listening');
  const origin = 'https://crew.test:' + edge.address().port;
  delete process.env.CREW_CONDUCTOR_URL;
  delete process.env.CREW_CONDUCTOR_TOKEN;
  delete process.env.CREW_RENDERER_URL;
  await app.whenReady();
  const pinned = new X509Certificate(pem).fingerprint256;
  session.defaultSession.setCertificateVerifyProc((req, done) => done(
    req.hostname === 'crew.test' && new X509Certificate(req.certificate.data).fingerprint256 === pinned ? 0 : -3
  ));
  require('../electron/main.cjs');
  await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().startsWith('file:')));
  const [first] = BrowserWindow.getAllWindows();
  await until(() => first.webContents.executeJavaScript('!!document.querySelector(".sidebar-brand")'));
  await first.webContents.executeJavaScript('document.querySelector(".sidebar-brand").click()');
  await until(() => first.webContents.executeJavaScript('!!document.querySelector("input[type=password]")'));
  await first.webContents.executeJavaScript(`(() => {
    function fill(input, text) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    fill(document.querySelector('input[placeholder="https://crew.example.com"]'), ${JSON.stringify(origin)});
    fill(document.querySelector('input[type=password]'), ${JSON.stringify(token)});
  })()`);
  await first.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b => b.textContent === "Connect to server").click()');
  await until(() => upgrades === 1 && snapshots > 0 && BrowserWindow.getAllWindows().length === 1);
  const [win] = BrowserWindow.getAllWindows();
  await until(() => win.webContents.executeJavaScript('document.body.innerText.includes("Remote team")'));
  assert.equal(statSync(join(temp, 'app.json')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(temp, 'app.json'))), { conductorUrl: origin, token });
  if (rejectUpgrade) {
    assert.equal(logins, 2);
    console.log('Electron renewed Access after a refused WebSocket upgrade.');
    return;
  }
  failure = process.argv.includes('--redirect') ? 302 : 403;
  await win.webContents.executeJavaScript(`fetch(${JSON.stringify(origin + '/api/state')}).then(r => r.status, () => 0)`);
  await until(() => logins === 2 && BrowserWindow.getAllWindows().length === 1);
  assert.equal(await win.webContents.executeJavaScript(`fetch(${JSON.stringify(origin + '/api/state')}).then(r => r.status)`), 200);
  console.log('Electron saved the server, signed in, opened WSS, read state over HTTPS and renewed a rejected Access session.');
}

run().then(() => app.exit(0), err => { console.error(err.message); app.exit(1); });
process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
