// Electron main process. Holds no agent logic: it opens a window and tells
// the renderer where the conductor is.
//
// Two ways to run:
// - From a checkout (`pnpm app`, or Crew.app from `pnpm install-app`): updates
//   are a git pull of main, see updateFromGit below.
// - Installed from the DMG (app.isPackaged): updates come from GitHub Releases
//   through electron-updater, see releaseUpdates below.

const { app, BrowserWindow, dialog, ipcMain, net, session, shell, nativeTheme } = require('electron');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createTeams } = require('./team.cjs');
const { installRelease } = require('./self-update.cjs');
const { ensureAccess, accessToken } = require('./access.cjs');
const { createServer } = require('node:http');

const CREW_HOME = process.env.CREW_HOME || join(homedir(), '.crew');
const APP_FILE = join(__dirname, '..', 'dist', 'index.html');
// Unpackaged (`electron .`), so the Dock shows Electron's icon unless we set ours.
// assets/icon.png is the app icon inset to the macOS icon grid (824 in 1024).
// The path works from electron/ (a checkout) and build/ (the bundled main in the DMG).
const ICON = join(__dirname, '..', 'electron', 'assets', 'icon.png');
const PRELOAD = join(__dirname, 'preload.cjs');
/**
 * Optional settings in ~/.crew/app.json:
 *   teamDir       the team folder the built-in conductor runs (default: the example team)
 *   env           extra environment for the built-in conductor, e.g. { "SHOPIFY_STORE": "…" }
 *   conductorUrl  + token: use a conductor elsewhere (a server) instead
 */
const SETTINGS_FILE = join(CREW_HOME, 'app.json');

/** True only for the app's own document (the built file or the dev server), never any other page. */
function isAppUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    if (process.env.CREW_RENDERER_URL) return url.origin === new URL(process.env.CREW_RENDERER_URL).origin;
    return url.href === pathToFileURL(APP_FILE).href;
  } catch {
    return false;
  }
}

function readSettings() {
  try {
    return existsSync(SETTINGS_FILE) ? JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) : {};
  } catch (err) {
    console.error(`[crew] ${SETTINGS_FILE}: ${err.message}`);
    return {};
  }
}

function writeSettings(settings) {
  mkdirSync(CREW_HOME, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

function conductorInfo() {
  // A conductor elsewhere (a server): CREW_CONDUCTOR_URL + CREW_CONDUCTOR_TOKEN, or ~/.crew/app.json.
  if (process.env.CREW_CONDUCTOR_URL && process.env.CREW_CONDUCTOR_TOKEN) {
    return { url: process.env.CREW_CONDUCTOR_URL, token: process.env.CREW_CONDUCTOR_TOKEN };
  }
  const settings = readSettings();
  // A server behind Cloudflare Access needs no token: the Access login is the credential.
  if (settings.conductorUrl) return { url: String(settings.conductorUrl).replace(/\/+$/, ''), token: String(settings.token ?? '') };
  // Otherwise the conductor on this Mac.
  try {
    const info = JSON.parse(readFileSync(join(CREW_HOME, 'conductor.json'), 'utf8'));
    return { url: `http://127.0.0.1:${info.port}`, token: info.token };
  } catch {
    return null;
  }
}

// The installed app brings its own conductor (Resources/runtime, built by
// scripts/build-runtime.mjs) and runs it on Electron's built-in Node, so
// nothing but the app is needed. It starts with the app, unless a conductor is
// already running (pnpm conductor, Crew.app from a checkout) or the settings
// point at one elsewhere, and it stops when the app quits.
let conductorChild = null;

function conductorRunning() {
  try {
    const { pid } = JSON.parse(readFileSync(join(CREW_HOME, 'conductor.json'), 'utf8'));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PATH as a login shell sees it: Finder starts apps with a bare PATH, and the agent CLIs live in the owner's. */
function loginPath() {
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 10_000 });
    return out.split('\n').at(-1) || process.env.PATH;
  } catch {
    return process.env.PATH;
  }
}

const RUNTIME = join(process.resourcesPath || '', 'runtime');
let cachedPath = null;
const teams = createTeams({
  crewHome: CREW_HOME,
  readSettings,
  writeSettings,
  env: () => ({ ...process.env, PATH: (cachedPath ??= loginPath()) }),
  exampleDir: join(RUNTIME, 'crew'),
});

/** True when this app runs its own conductor (installed, and not pointed elsewhere). */
function ownsConductor() {
  return app.isPackaged && !process.env.CREW_CONDUCTOR_URL && !readSettings().conductorUrl;
}

let launchInFlight = null;
function startConductor() {
  launchInFlight ??= launchConductor().finally(() => { launchInFlight = null; });
  return launchInFlight;
}

async function launchConductor() {
  if (!ownsConductor() || conductorChild || conductorRunning()) return;
  const settings = readSettings();
  const logs = join(CREW_HOME, 'logs');
  mkdirSync(logs, { recursive: true });
  const team = teams.config();
  // A GitHub team needs Crew's clone before the first start (later starts reuse it).
  if (team.kind === 'github') {
    try {
      await teams.ensureClone(team);
    } catch (err) {
      console.error(`[crew] ${err.message}`);
    }
  }
  if (conductorRunning()) return;
  const log = openSync(join(logs, 'conductor.log'), 'a');
  try {
    conductorChild = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', join(RUNTIME, 'apps', 'conductor', 'src', 'main.ts')],
      {
        cwd: RUNTIME,
        env: {
          ...process.env,
          ...(settings.env && typeof settings.env === 'object' ? settings.env : {}),
          ELECTRON_RUN_AS_NODE: '1',
          PATH: (cachedPath ??= loginPath()),
          CREW_TEAM_DIR: process.env.CREW_TEAM_DIR || teams.teamDir(team),
        },
        stdio: ['ignore', log, log],
      },
    );
  } finally {
    closeSync(log);
  }
  const child = conductorChild;
  child.once('error', (err) => console.error('[crew] conductor:', err.message));
  child.once('close', (code) => {
    console.error(`[crew] conductor exited (${code}); see ${join(logs, 'conductor.log')}`);
    if (conductorChild === child) conductorChild = null;
  });
}

/** Stops this app's conductor and waits for it (it stops running turns first; they can be resumed). */
function stopConductor() {
  const child = conductorChild;
  if (!child) return Promise.resolve();
  conductorChild = null;
  return new Promise((done) => {
    child.once('exit', () => done());
    child.kill('SIGTERM');
    setTimeout(done, 15_000);
  });
}

async function restartConductor() {
  await stopConductor();
  await startConductor();
}

app.on('before-quit', () => {
  // The conductor stops its running turns on SIGTERM; they can be resumed later.
  conductorChild?.kill('SIGTERM');
});

// The Team screen and the sidebar's team update button.
ipcMain.handle('crew:team-info', async () => ({ supported: ownsConductor(), ...(await teams.info()) }));
ipcMain.handle('crew:team-set', async (_e, next) => {
  if (!ownsConductor()) return 'Only the installed Crew app runs its own team. From a checkout, set CREW_TEAM_DIR in .env.local.';
  try {
    await teams.set(next);
    await restartConductor();
    return null;
  } catch (err) {
    return String(err.message || err);
  }
});
ipcMain.handle('crew:team-choose-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { title: 'Choose the team folder', properties: ['openDirectory'], message: 'The folder with agent/agent.ts, for example the crew folder in your repo.' });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
ipcMain.handle('crew:team-check', () => (ownsConductor() ? teams.check() : null));
ipcMain.handle('crew:team-apply', async () => {
  try {
    await teams.update();
    await restartConductor();
    return null;
  } catch (err) {
    return String(err.message || err);
  }
});

// A sign-in running on a server (an engine or Shopify) may send the browser back
// to 127.0.0.1:<port>, where the CLI listens, but on the server. Listen on
// that port on this Mac for a while and pass the address on to the server.
const relays = new Map();
ipcMain.handle('crew:login-relay', async (event, port, loginId) => {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !isAppUrl(frame.url)) return 'Not allowed.';
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof loginId !== 'string') return 'Bad sign-in.';
  const info = conductorInfo();
  if (!info) return 'Not connected to the server.';
  relays.get(port)?.close();
  const server = createServer(async (req, res) => {
    const text = `http://127.0.0.1:${port}${req.url}`;
    let ok = false;
    try {
      const token = accessToken();
      const r = await fetch(`${info.url}/api/logins/${encodeURIComponent(loginId)}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}`, ...(token ? { 'cf-access-token': token } : {}) },
        body: JSON.stringify({ text }),
      });
      ok = r.ok;
    } catch {}
    res.writeHead(ok ? 200 : 502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Crew</title><body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh"><div style="text-align:center"><h2>${ok ? 'Done' : 'That did not work'}</h2><p>${ok ? 'You can close this tab and go back to Crew.' : 'Go back to Crew and try again.'}</p></div>`);
    if (ok) setTimeout(() => server.close(), 1000);
  });
  relays.set(port, server);
  setTimeout(() => server.close(), 15 * 60_000).unref();
  server.on('close', () => relays.get(port) === server && relays.delete(port));
  return await new Promise((resolve) => {
    server.once('error', (err) => resolve(`Could not listen on port ${port} for the sign-in: ${err.message}`));
    server.listen(port, '127.0.0.1', () => resolve(null));
  });
});

// Where Crew runs: on this Mac (its own conductor) or on a server.
function serverUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.pathname.replace(/\/+$/, '') || u.search) return null;
    return u.origin;
  } catch {
    return null;
  }
}

ipcMain.handle('crew:where-info', () => {
  if (process.env.CREW_CONDUCTOR_URL) return { mode: 'server', url: process.env.CREW_CONDUCTOR_URL, fixed: true };
  const s = readSettings();
  return s.conductorUrl ? { mode: 'server', url: s.conductorUrl, fixed: !app.isPackaged } : { mode: 'local', url: null, fixed: !app.isPackaged };
});
ipcMain.handle('crew:where-set', async (event, next) => {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !isAppUrl(frame.url)) return 'Not allowed.';
  if (!app.isPackaged || process.env.CREW_CONDUCTOR_URL) return 'From a checkout, set this with CREW_CONDUCTOR_URL.';
  const settings = readSettings();
  if (next?.mode === 'server') {
    const url = serverUrl(next.url);
    if (!url) return 'Enter the server address, for example crew.example.com.';
    settings.conductorUrl = url;
    delete settings.token;
    writeSettings(settings);
    await stopConductor();
  } else {
    delete settings.conductorUrl;
    delete settings.token;
    writeSettings(settings);
    await startConductor().catch((err) => console.error('[crew] conductor:', err.message));
  }
  // Reconnect from scratch against the new conductor.
  BrowserWindow.fromWebContents(event.sender)?.webContents.reload();
  return null;
});

const BROWSER_PARTITION = 'persist:crew-browser';
const isWebUrl = (url) => /^https?:\/\//i.test(url);

ipcMain.handle('crew:open-external', (event, url) => {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !isAppUrl(frame.url)) return;
  if (typeof url === 'string' && isWebUrl(url)) return shell.openExternal(url);
});

/** The browser tab's session: pages get no permissions (camera, notifications, location, …). */
function hardenBrowserSession() {
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function createWindow() {
  const win = new BrowserWindow({
    icon: ICON,
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    title: 'Crew',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 13 }, // centred in the 40px title bar (app.css .titlebar, --cr-height-titlebar)
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      additionalArguments: ownsConductor() ? ['--crew-local-conductor'] : [],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true, // the browser tab in the preview panel
    },
  });

  // Web links open in the browser tab of the preview panel, as in T3 Code. Cmd-click (a background
  // tab) still opens the system browser, and so does a link when no thread is on screen.
  const openUrl = (url) => win.webContents.send('crew:open-url', url);
  win.webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:/.test(url)) {
      if (disposition === 'background-tab') shell.openExternal(url);
      else openUrl(url);
    } else if (/^mailto:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window only ever shows the app.
  const guard = (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) openUrl(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return guard(e, e.url);
    // A preview iframe is a srcdoc document. A link clicked inside it would load the page into
    // the frame, and most sites refuse to be framed, which leaves the preview blank.
    if (/^https?:/.test(e.url)) {
      e.preventDefault();
      openUrl(e.url);
    }
  });

  // The browser tab is a <webview> in its own persistent session (sign-ins stay), with no preload
  // and no Node, and only web pages.
  // Preferences are rebuilt rather than trusted: the <webview> attributes could ask for more.
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    if (params.partition !== BROWSER_PARTITION || !isWebUrl(params.src || '')) {
      e.preventDefault();
      return;
    }
    for (const key of ['preload', 'enableBlinkFeatures', 'disableBlinkFeatures', 'additionalArguments']) delete prefs[key];
    Object.assign(prefs, {
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    });
  });
  win.webContents.on('did-attach-webview', (_e, guest) => {
    // A page's new tab or window becomes another browser tab in the panel; cmd-click goes to the
    // system browser, as in the rest of the app.
    guest.setWindowOpenHandler(({ url, disposition }) => {
      if (isWebUrl(url)) {
        if (disposition === 'background-tab') shell.openExternal(url);
        else openUrl(url);
      } else if (/^mailto:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    // The page itself stays on web pages, also after a redirect. Its own iframes may be about:blank.
    const onlyWeb = (e) => {
      if (!e.isMainFrame || isWebUrl(e.url)) return;
      e.preventDefault();
      if (/^mailto:/i.test(e.url)) shell.openExternal(e.url);
    };
    guest.on('will-frame-navigate', onlyWeb);
    guest.on('will-redirect', onlyWeb);
  });

  const hash = process.env.CREW_OPEN || '';
  if (process.env.CREW_RENDERER_URL) win.loadURL(process.env.CREW_RENDERER_URL + hash);
  else win.loadFile(APP_FILE, { hash: hash.replace(/^#/, '') });

  // Development aid: CREW_SNAPSHOT=/path.png captures the window after load and quits.
  if (process.env.CREW_SNAPSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require('node:fs').writeFileSync(process.env.CREW_SNAPSHOT, img.toPNG());
        app.quit();
      }, Number(process.env.CREW_SNAPSHOT_DELAY || 2500));
    });
  }
}

// Updates. The renderer asks `crew:update-check` for an UpdateInfo or null and
// calls `crew:update-apply` when the owner clicks the sidebar's update button.
//   { badge, title, stopsAgents }  shown on the button
// apply resolves with an error message, or null once it is under way.

// From a checkout (only when opened from Crew.app, see scripts/install-app.sh):
// an update is a fast-forward pull of main. Exit code 75 tells the launcher to
// reinstall dependencies and start everything again, the conductor included.
const REPO = join(__dirname, '..', '..', '..');
const RESTART_CODE = 75;
const git = (...args) =>
  new Promise((resolve, reject) =>
    execFile('git', args, { cwd: REPO, timeout: 60_000 }, (err, out) => (err ? reject(err) : resolve(out.trim()))),
  );

const updateFromGit = {
  async check() {
    if (!process.env.CREW_LAUNCHER) return null;
    try {
      if ((await git('rev-parse', '--abbrev-ref', 'HEAD')) !== 'main') return null;
      if (await git('status', '--porcelain')) return null;
      await git('fetch', '--quiet', 'origin', 'main');
      const count = Number(await git('rev-list', '--count', 'HEAD..origin/main'));
      if (!count) return null;
      return { badge: String(count), title: `${count} new change${count === 1 ? '' : 's'} on main. Click to update and restart.`, stopsAgents: true };
    } catch {
      return null;
    }
  },
  async apply() {
    try {
      await git('pull', '--ff-only', '--quiet', 'origin', 'main');
    } catch (err) {
      return String(err.message || err);
    }
    app.exit(RESTART_CODE);
    return null;
  },
};

// Installed from the DMG: GitHub Releases of this repo (electron-builder's
// publish setting writes the feed into the app). Clicking Update Crew installs
// the new version and restarts into it, like any Mac app. A build signed with
// a Developer ID uses Apple's updater (downloaded in the background, installed
// on restart); an unsigned build installs it itself (self-update.cjs). The
// built-in conductor stops for the restart, so running agents stop too.
const releaseUpdates = (() => {
  let updater = null;
  let available = null; // electron-updater's UpdateInfo for a newer version
  let ready = null; // version downloaded by Apple's updater (signed builds)
  const pkg = (() => {
    try {
      return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  const signed = pkg.crewSigned === true;
  const repo = pkg.crewRepo || 'pveen2/crew';

  function start() {
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = signed;
    updater.autoInstallOnAppQuit = signed;
    // Releases are plain versions (v0.1.7). A local build such as 0.1.6-local.1 would otherwise
    // look only for "local" pre-releases and never offer an update.
    updater.allowPrerelease = false;
    // Errors are logged once, by the 'error' handler below.
    updater.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    updater.on('update-available', (info) => {
      available = info;
    });
    updater.on('update-downloaded', (info) => {
      ready = info.version;
    });
    updater.on('error', (err) => console.error('[crew] update:', err?.message || err));
    const check = () => updater.checkForUpdates().catch(() => {});
    check();
    setInterval(check, 4 * 60 * 60_000);
  }

  return {
    start,
    async check() {
      const version = signed ? ready : available?.version;
      if (!version) return null;
      return { badge: version, title: `Crew ${version} is ready. Click to install it and restart.`, stopsAgents: ownsConductor() };
    },
    async apply() {
      try {
        if (signed && ready) {
          await stopConductor();
          setImmediate(() => updater.quitAndInstall());
          return null;
        }
        if (!available) return 'No update is waiting.';
        const info = available;
        await installRelease({
          info,
          repo,
          fetchImpl: (url) => net.fetch(url),
          logDir: join(CREW_HOME, 'logs'),
          quit: () => {
            // Stop the conductor first, so the new version starts its own on a free port.
            void stopConductor().then(() => app.quit());
          },
        });
        return null;
      } catch (err) {
        const page = available ? `https://github.com/${repo}/releases/tag/v${available.version}` : `https://github.com/${repo}/releases`;
        return `${err.message || err}\n\nYou can also download it from ${page}`;
      }
    },
  };
})();

const updates = app.isPackaged ? releaseUpdates : updateFromGit;
ipcMain.handle('crew:update-check', () => updates.check());
ipcMain.handle('crew:update-apply', () => updates.apply());

// The conductor token is handed only to the app's own top-level document.
ipcMain.handle('crew:info', async (event) => {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !isAppUrl(frame.url)) return null;
  const info = conductorInfo();
  // A conductor on a server sits behind Cloudflare Access: sign in first.
  if (info && !(await ensureAccess(info.url, CREW_HOME))) return null;
  return info;
});

ipcMain.handle('crew:start-conductor', async (event) => {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !isAppUrl(frame.url) || !ownsConductor()) {
    throw new Error('This window cannot start a local conductor.');
  }
  await startConductor();
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system';
  if (app.isPackaged) {
    void startConductor().catch((err) => console.error('[crew] conductor:', err.message));
    releaseUpdates.start();
  }
  if (process.platform === 'darwin') app.dock?.setIcon(ICON);
  hardenBrowserSession();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
