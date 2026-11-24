// Cloudflare Access for a conductor on a server. The renderer is a file://
// page, so the browser would never send Cloudflare's CF_Authorization cookie
// along with its requests. Instead the person signs in in their own browser
// (password managers and passkeys work there): the conductor's
// /auth/app-login, behind Access, sends the login back to a one-off listener
// on 127.0.0.1, and the main process adds it as the cf-access-token header to
// every request for the conductor's host. The login is kept in
// ~/.crew/access.json (mode 600) until it expires.

const { session, shell } = require('electron');
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SIGN_IN_TIMEOUT = 5 * 60_000;
let crewHome = null;
let token = null;
let hookedHost = null;
let signingIn = null;
let declinedUntil = 0;

function storeFile() {
  return join(crewHome, 'access.json');
}

function isRemote(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

function expiresAt(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).exp * 1000;
  } catch {
    return 0;
  }
}

const fresh = (jwt) => Boolean(jwt) && expiresAt(jwt) > Date.now() + 60_000;

function readStored(host) {
  try {
    const all = existsSync(storeFile()) ? JSON.parse(readFileSync(storeFile(), 'utf8')) : {};
    return fresh(all[host]) ? all[host] : null;
  } catch {
    return null;
  }
}

function writeStored(host, jwt) {
  let all = {};
  try {
    if (existsSync(storeFile())) all = JSON.parse(readFileSync(storeFile(), 'utf8'));
  } catch {}
  all[host] = jwt;
  mkdirSync(crewHome, { recursive: true });
  writeFileSync(storeFile(), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Crew</title>
<body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#222">
<div style="text-align:center"><h2>Signed in to Crew</h2><p>You can close this tab and go back to the app.</p></div>`;

/** Opens the sign-in in the default browser and waits for the login to come back to 127.0.0.1. */
function signIn(origin) {
  const state = randomBytes(24).toString('base64url');
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const jwt = url.searchParams.get('token') ?? '';
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || !fresh(jwt)) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('This sign-in link is not valid. Start again from the Crew app.');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(DONE_PAGE);
      finish(null, jwt);
    });
    const timer = setTimeout(() => finish(new Error('Sign-in timed out')), SIGN_IN_TIMEOUT);
    function finish(err, jwt) {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(jwt);
    }
    server.on('error', (err) => finish(err));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      void shell.openExternal(`${origin}/auth/app-login?port=${port}&state=${state}`);
    });
  });
}

function hook(origin) {
  const host = new URL(origin).host;
  if (hookedHost === host) return;
  hookedHost = host;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`https://${host}/*`, `wss://${host}/*`] }, (details, callback) => {
    if (token) details.requestHeaders['cf-access-token'] = token;
    callback({ requestHeaders: details.requestHeaders });
  });
}

/**
 * Makes sure requests to a remote conductor carry a valid Access login,
 * signing in through the browser when there is none (or it is about to
 * expire). False when sign-in failed or timed out; the app then waits a
 * little before asking again.
 */
async function ensureAccess(conductorUrl, home) {
  if (!isRemote(conductorUrl)) return true;
  crewHome = home;
  const origin = new URL(conductorUrl).origin;
  const host = new URL(origin).host;
  hook(origin);
  if (fresh(token)) return true;
  const stored = readStored(host);
  if (stored) {
    token = stored;
    return true;
  }
  if (Date.now() < declinedUntil) return false;
  try {
    signingIn ??= signIn(origin).finally(() => (signingIn = null));
    token = await signingIn;
    writeStored(host, token);
    return true;
  } catch {
    declinedUntil = Date.now() + 30_000;
    return false;
  }
}

module.exports = { ensureAccess };
