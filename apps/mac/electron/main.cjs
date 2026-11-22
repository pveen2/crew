// Electron main process. Holds no agent logic: it opens a window and tells
// the renderer where the conductor is (port + token from ~/.crew/conductor.json).

const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const { execFile } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const CREW_HOME = process.env.CREW_HOME || join(homedir(), '.crew');
const APP_FILE = join(__dirname, '..', 'dist', 'index.html');
// Unpackaged (`electron .`), so the Dock shows Electron's icon unless we set ours.
// assets/icon.png is the app icon inset to the macOS icon grid (824 in 1024).
const ICON = join(__dirname, 'assets', 'icon.png');

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

function conductorInfo() {
  // A remote conductor later: set CREW_CONDUCTOR_URL and CREW_CONDUCTOR_TOKEN.
  if (process.env.CREW_CONDUCTOR_URL && process.env.CREW_CONDUCTOR_TOKEN) {
    return { url: process.env.CREW_CONDUCTOR_URL, token: process.env.CREW_CONDUCTOR_TOKEN };
  }
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
      preload: join(__dirname, 'preload.cjs'),
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

// Updates (only when opened from Crew.app, see scripts/install-app.sh): the app
// runs a git checkout, so an update is a fast-forward pull of main. Exit code 75
// tells the launcher to reinstall dependencies and start everything again.
const REPO = join(__dirname, '..', '..', '..');
const RESTART_CODE = 75;
const git = (...args) =>
  new Promise((resolve, reject) =>
    execFile('git', args, { cwd: REPO, timeout: 60_000 }, (err, out) => (err ? reject(err) : resolve(out.trim()))),
  );

/** Commits on origin/main this checkout lacks; 0 when not on a clean main. */
async function updateCount() {
  if (!process.env.CREW_LAUNCHER) return 0;
  try {
    if ((await git('rev-parse', '--abbrev-ref', 'HEAD')) !== 'main') return 0;
    if (await git('status', '--porcelain')) return 0;
    await git('fetch', '--quiet', 'origin', 'main');
    return Number(await git('rev-list', '--count', 'HEAD..origin/main'));
  } catch {
    return 0;
  }
}

ipcMain.handle('crew:update-check', () => updateCount());
ipcMain.handle('crew:update-apply', async () => {
  try {
    await git('pull', '--ff-only', '--quiet', 'origin', 'main');
  } catch (err) {
    return String(err.message || err);
  }
  app.exit(RESTART_CODE);
  return null;
});

// The conductor token is handed only to the app's own top-level document.
ipcMain.handle('crew:info', (event) => {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !isAppUrl(frame.url)) return null;
  return conductorInfo();
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system';
  if (process.platform === 'darwin') app.dock?.setIcon(ICON);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
