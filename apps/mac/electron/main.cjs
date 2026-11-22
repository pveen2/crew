// Electron main process. Holds no agent logic: it opens a window and tells
// the renderer where the conductor is.
//
// Two ways to run:
// - From a checkout (`pnpm app`, or Crew.app from `pnpm install-app`): updates
//   are a git pull of main, see updateFromGit below.
// - Installed from the DMG (app.isPackaged): updates come from GitHub Releases
//   through electron-updater, see releaseUpdates below.

const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const { execFile } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const CREW_HOME = process.env.CREW_HOME || join(homedir(), '.crew');
const APP_FILE = join(__dirname, '..', 'dist', 'index.html');
// Unpackaged (`electron .`), so the Dock shows Electron's icon unless we set ours.
// assets/icon.png is the app icon inset to the macOS icon grid (824 in 1024).
// The path works from electron/ (a checkout) and build/ (the bundled main in the DMG).
const ICON = join(__dirname, '..', 'electron', 'assets', 'icon.png');
const PRELOAD = join(__dirname, 'preload.cjs');
/** Optional settings: { "conductorUrl": "https://…", "token": "…" } for a conductor elsewhere. */
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
// publish setting writes the feed into the app). A signed build downloads the
// update in the background and installs it on restart. macOS only installs
// updates into a signed app, so an unsigned build only says a new version is
// out and opens its download page. Restarting the app does not stop agents:
// the conductor is a separate process.
const releaseUpdates = (() => {
  let updater = null;
  let available = null; // version on GitHub, newer than this one
  let ready = null; // version downloaded and ready to install
  let pageUrl = null;
  const pkg = (() => {
    try {
      return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  const canInstall = pkg.crewSigned === true;

  function start() {
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = canInstall;
    updater.autoInstallOnAppQuit = canInstall;
    // Errors are logged once, by the 'error' handler below.
    updater.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    updater.on('update-available', (info) => {
      available = info.version;
      pageUrl = `https://github.com/${pkg.crewRepo || 'pveen2/crew'}/releases/tag/v${info.version}`;
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
      if (ready) return { badge: ready, title: `Crew ${ready} is ready. Click to restart into it.`, stopsAgents: false };
      if (available && !canInstall) return { badge: available, title: `Crew ${available} is out. Click to download it.`, stopsAgents: false };
      return null;
    },
    async apply() {
      if (ready) {
        setImmediate(() => updater.quitAndInstall());
        return null;
      }
      if (pageUrl) {
        await shell.openExternal(pageUrl);
        return null;
      }
      return 'No update is waiting.';
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
  if (app.isPackaged) releaseUpdates.start();
  if (process.platform === 'darwin') app.dock?.setIcon(ICON);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
