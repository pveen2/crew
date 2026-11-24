// Cloudflare Access for a conductor on a server. The renderer is a file://
// page, so the browser would never send Cloudflare's CF_Authorization cookie
// along with its requests. Instead the main process signs in once in its own
// window, keeps the cookie in a separate session, and adds it as the
// cf-access-token header to every request for the conductor's host.

const { app, BrowserWindow, session } = require('electron');

const PARTITION = 'persist:crew-access';
let token = null;
let hookedHost = null;
let signingIn = null;
let declinedUntil = 0;

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

async function storedToken(origin) {
  const [cookie] = await session.fromPartition(PARTITION).cookies.get({ url: origin, name: 'CF_Authorization' });
  return cookie && expiresAt(cookie.value) > Date.now() + 60_000 ? cookie.value : null;
}

function signIn(origin, parent) {
  const ses = session.fromPartition(PARTITION);
  const host = new URL(origin).hostname;
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parent ?? undefined,
      modal: Boolean(parent),
      title: 'Sign in to Crew',
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    // Google refuses sign-in from browsers that call themselves Electron.
    win.webContents.setUserAgent(app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(/ Crew\/\S+/i, ''));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    let settled = false;
    const onCookie = (_e, cookie, _cause, removed) => {
      if (removed || cookie.name !== 'CF_Authorization' || cookie.domain.replace(/^\./, '') !== host) return;
      settled = true;
      ses.cookies.removeListener('changed', onCookie);
      resolve(cookie.value);
      if (!win.isDestroyed()) win.close();
    };
    ses.cookies.on('changed', onCookie);
    win.on('closed', () => {
      ses.cookies.removeListener('changed', onCookie);
      if (!settled) reject(new Error('Sign-in window closed'));
    });
    void win.loadURL(`${origin}/`);
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
 * Makes sure requests to a remote conductor carry a valid Access token, signing
 * in when there is none (or it is about to expire). False when the person
 * closed the sign-in window; the app then waits a little before asking again.
 */
async function ensureAccess(conductorUrl, parent) {
  if (!isRemote(conductorUrl)) return true;
  const origin = new URL(conductorUrl).origin;
  hook(origin);
  const stored = await storedToken(origin);
  if (stored) {
    token = stored;
    return true;
  }
  if (Date.now() < declinedUntil) return false;
  try {
    signingIn ??= signIn(origin, parent).finally(() => (signingIn = null));
    token = await signingIn;
    return true;
  } catch {
    declinedUntil = Date.now() + 30_000;
    return false;
  }
}

module.exports = { ensureAccess };
