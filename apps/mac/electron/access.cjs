const { BrowserWindow, session } = require('electron');

function serverOrigin(value) {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(url.hostname)) throw new Error('Enter a valid server hostname.');
  if (local && url.protocol === 'http:') url.hostname = '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Use an HTTPS server URL.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Enter the server origin without a path or credentials.');
  return { origin: url.origin, remote: !local };
}

function validToken(cookie) {
  try {
    const claims = JSON.parse(Buffer.from(cookie.value.split('.')[1], 'base64url').toString());
    return Number.isFinite(claims.exp) && claims.exp > Date.now() / 1000;
  } catch { return false; }
}

// One Access login for this app window. The preview browser has its own partition.
function createAccess(win, origin, token) {
  const ses = session.defaultSession;
  const { host, hostname } = new URL(origin);
  const filter = { urls: [origin + '/*', 'wss://' + host + '/*'] };
  let login = null;
  let pending = null;
  let cancelled = false;
  let disposed = false;
  let recovery = null;
  let lastRecovery = 0;
  let probing = false;

  async function cookies() {
    const all = await ses.cookies.get({ url: origin });
    const auth = all.find(c => c.name === 'CF_Authorization' && validToken(c));
    const binding = all.find(c => c.name === 'CF_Binding');
    return { auth, binding };
  }

  async function signIn() {
    if (disposed || cancelled) return false;
    if (pending) return pending;
    if ((await cookies()).auth) return true;
    if (disposed || cancelled) return false;
    if (pending) return pending;
    login = new BrowserWindow({
      parent: win, width: 620, height: 760, title: 'Sign in to Crew',
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const page = login.webContents;
    page.setWindowOpenHandler(() => ({ action: 'deny' }));
    const httpsOnly = (e, url) => { if (!url.startsWith('https://')) e.preventDefault(); };
    page.on('will-navigate', httpsOnly);
    page.on('will-redirect', httpsOnly);
    let success = false;
    const check = async () => {
      if (!page.isDestroyed() && page.getURL().startsWith(origin + '/') && (await cookies()).auth && !page.isDestroyed()) {
        success = true;
        login?.close();
      }
    };
    const changed = (_event, c, _cause, removed) => {
      if (!removed && c.name === 'CF_Authorization' && c.domain?.replace(/^\./, '') === hostname) void check().catch(() => {});
    };
    ses.cookies.on('changed', changed);
    page.on('did-finish-load', () => void check().catch(() => {}));
    pending = new Promise(resolve => login.once('closed', () => {
      ses.cookies.removeListener('changed', changed);
      cancelled = !success;
      login = null;
      pending = null;
      resolve(success);
    }));
    void login.loadURL(origin).catch(() => {});
    return pending;
  }

  function accessHeaders(auth, binding) {
    return {
      'cf-access-token': auth.value,
      Cookie: 'CF_Authorization=' + auth.value + (binding ? '; CF_Binding=' + binding.value : ''),
    };
  }

  function trusted(d) {
    if (disposed || win.isDestroyed() || d.webContentsId !== win.webContents.id) return false;
    const url = new URL(d.url);
    if (url.host !== host) return false;
    if (d.frame && d.frame !== win.webContents.mainFrame) return false;
    return (url.protocol === 'https:' && url.pathname.startsWith('/api/') && d.resourceType === 'xhr') ||
      (url.protocol === 'wss:' && url.pathname === '/ws' && url.searchParams.get('token') === token);
  }

  ses.webRequest.onBeforeSendHeaders(filter, (d, callback) => {
    if (!trusted(d)) return callback({});
    void cookies().then(({ auth, binding }) => {
      if (disposed || !auth) {
        if (!disposed) void signIn().catch(() => {});
        return callback({ cancel: true });
      }
      const headers = { ...d.requestHeaders };
      for (const name of Object.keys(headers)) {
        if (['cookie', 'cf-access-token', 'authorization'].includes(name.toLowerCase())) delete headers[name];
      }
      Object.assign(headers, accessHeaders(auth, binding));
      if (d.resourceType !== 'webSocket') headers.Authorization = 'Bearer ' + token;
      callback({ requestHeaders: headers });
    }).catch(() => callback({ cancel: true }));
  });

  function renew() {
    if (recovery || cancelled || disposed) return;
    // A denied policy must leave the Server form usable, including after an automatic SSO.
    if (Date.now() - lastRecovery < 15_000) { cancelled = true; return; }
    lastRecovery = Date.now();
    recovery = (async () => {
      await Promise.all(['CF_Authorization', 'CF_Binding'].map(name => ses.cookies.remove(origin, name)));
      return signIn();
    })().catch(() => false).finally(() => { recovery = null; });
  }

  function tokenRejected() {
    cancelled = true;
    win.webContents.send('crew:server-error', 'The conductor rejected the token. Enter the current token in Team > Server.');
  }

  // Chromium hides non-101 handshake responses. Check HTTP before reopening login on a failed upgrade.
  ses.webRequest.onErrorOccurred(filter, async d => {
    if (!trusted(d) || d.resourceType !== 'webSocket' || d.error !== 'net::ERR_FAILED' || probing || recovery || cancelled) return;
    probing = true;
    try {
      const { auth, binding } = await cookies();
      if (!auth) return renew();
      const res = await ses.fetch(origin + '/api/state', {
        redirect: 'manual', signal: AbortSignal.timeout(5000),
        headers: { authorization: 'Bearer ' + token, ...accessHeaders(auth, binding) },
      });
      await res.body?.cancel();
      if (disposed) return;
      if (res.status === 401 && res.headers.get('www-authenticate') === 'Bearer realm="Crew"') tokenRejected();
      else if (res.ok || res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) renew();
    } catch { /* The renderer retries a network outage. */ }
    finally { probing = false; }
  });

  ses.webRequest.onHeadersReceived(filter, (d, callback) => {
    if (!trusted(d)) return callback({});
    const header = name => Object.entries(d.responseHeaders || {}).find(([k]) => k.toLowerCase() === name)?.[1]?.[0] || '';
    const location = header('location');
    if (d.statusCode >= 300 && d.statusCode < 400 && location) {
      try { if (new URL(location, origin).hostname.endsWith('.cloudflareaccess.com')) renew(); } catch {}
      return callback({ cancel: true });
    }
    if ([401, 403].includes(d.statusCode)) {
      if (header('www-authenticate') === 'Bearer realm="Crew"') {
        tokenRejected();
      } else renew();
    }
    callback({});
  });

  return {
    ready: () => recovery || signIn(),
    close() {
      disposed = true;
      login?.close();
      ses.webRequest.onBeforeSendHeaders(null);
      ses.webRequest.onHeadersReceived(null);
      ses.webRequest.onErrorOccurred(null);
    },
  };
}

module.exports = { createAccess, serverOrigin };
