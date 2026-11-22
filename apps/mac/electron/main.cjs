// Electron main process. Holds no agent logic: it opens a window and tells
// the renderer where the conductor is.
//
// Two ways to run:
// - From a checkout (`pnpm app`, or Crew.app from `pnpm install-app`): updates
//   are a git pull of main, see updateFromGit below.
// - Installed from the DMG (app.isPackaged): updates come from GitHub Releases
//   through electron-updater, see releaseUpdates below.

const { app, BrowserWindow, dialog, ipcMain, net, shell, nativeTheme } = require('electron');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createTeams } = require('./team.cjs');
const { installRelease } = require('./self-update.cjs');

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
  if (settings.conductorUrl && settings.token) return { url: String(settings.conductorUrl).replace(/\/+$/, ''), token: String(settings.token) };
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

async function startConductor() {
  if (!ownsConductor() || conductorChild || conductorRunning()) return;
  const settings = readSettings();
  const logs = join(CREW_HOME, 'logs');
  mkdirSync(logs, { recursive: true });
  const log = openSync(join(logs, 'conductor.log'), 'a');
  const team = teams.config();
  // A GitHub team needs Crew's clone before the first start (later starts reuse it).
  if (team.kind === 'github') {
    try {
      await teams.ensureClone(team);
    } catch (err) {
      console.error(`[crew] ${err.message}`);
    }
  }
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
  const child = conductorChild;
  child.on('exit', (code) => {
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
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window only ever shows the app. Links open in the system browser.
  const guard = (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame) return; // preview iframes are sandboxed srcdoc
    guard(e, e.url);
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
ipcMain.handle('crew:info', (event) => {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !isAppUrl(frame.url)) return null;
  return conductorInfo();
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system';
  if (app.isPackaged) {
    void startConductor();
    releaseUpdates.start();
  }
  if (process.platform === 'darwin') app.dock?.setIcon(ICON);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
