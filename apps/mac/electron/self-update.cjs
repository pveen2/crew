// Installs a new release into an unsigned (ad-hoc signed) Crew, like a normal
// app update: Apple's updater (Squirrel) only installs into apps signed with a
// Developer ID, so until Crew is signed it updates itself.
//
//   1. Download this Mac's ZIP of the release from GitHub Releases and check it
//      against the SHA-512 in the release's latest-mac.yml.
//   2. Unpack it next to the running app and check its version and signature.
//   3. Quit; a small script waits for Crew to exit, swaps the app bundles
//      (putting the old one back if anything fails) and opens the new one.
//
// A file Crew downloads itself is not marked "from the internet", so the new
// version opens without a Gatekeeper prompt.

const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { accessSync, constants, createWriteStream, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 5 * 60_000 }, (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim())) : resolve(out.trim()))),
  );

/** The running .app bundle: …/Crew.app/Contents/MacOS/Crew → …/Crew.app */
function runningBundle() {
  return dirname(dirname(dirname(process.execPath)));
}

/** Why this copy cannot replace itself, or null when it can. */
function cannotInstall(bundle = runningBundle()) {
  if (!bundle.endsWith('.app')) return 'Crew is not running from an app bundle.';
  if (bundle.includes('/AppTranslocation/')) {
    return 'macOS runs this copy of Crew from a temporary place. Move Crew to Applications (drag it there in Finder), open it from there and update again.';
  }
  try {
    accessSync(dirname(bundle), constants.W_OK);
    accessSync(bundle, constants.W_OK);
  } catch {
    return `Crew cannot write to ${dirname(bundle)}. Move Crew to Applications, or install the update by hand.`;
  }
  return null;
}

/** The release file for this Mac: the arm64 ZIP on Apple silicon, the other ZIP on Intel. */
function pickZip(files) {
  const zips = (files || []).filter((f) => /\.zip$/i.test(f.url));
  return process.arch === 'arm64' ? zips.find((f) => /arm64/i.test(f.url)) : zips.find((f) => !/arm64/i.test(f.url));
}

async function download(url, dest, sha512, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const hash = createHash('sha512');
  const tap = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(dest));
  const got = hash.digest('base64');
  if (got !== sha512) throw new Error('The downloaded update does not match its checksum; nothing was changed.');
}

/**
 * Downloads, checks and stages `info` (electron-updater's UpdateInfo), then
 * starts the swap script and calls `quit`. Throws with a readable message, in
 * which case nothing has been changed.
 */
async function installRelease({ info, repo, fetchImpl, quit, logDir, reopen = true }) {
  const bundle = runningBundle();
  const blocked = cannotInstall(bundle);
  if (blocked) throw new Error(blocked);
  const file = pickZip(info.files);
  if (!file?.sha512) throw new Error(`Release ${info.version} has no ZIP for this Mac.`);

  // Staged next to the app, so the final swap is a rename on the same disk.
  const stage = join(dirname(bundle), `.Crew-update-${info.version}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    const zip = join(stage, 'update.zip');
    const url = `https://github.com/${repo}/releases/download/v${info.version}/${encodeURIComponent(file.url)}`;
    await download(url, zip, file.sha512, fetchImpl);
    const unpacked = join(stage, 'app');
    await run('ditto', ['-x', '-k', zip, unpacked]);
    rmSync(zip, { force: true });
    const name = readdirSync(unpacked).find((n) => n.endsWith('.app'));
    if (!name) throw new Error('The update has no app in it.');
    const next = join(unpacked, name);
    const version = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(next, 'Contents', 'Info.plist')]);
    if (version !== info.version) throw new Error(`The update says it is ${version}, not ${info.version}.`);
    await run('codesign', ['--verify', '--deep', '--strict', next]);
    await run('xattr', ['-dr', 'com.apple.quarantine', next]).catch(() => {});

    const script = join(stage, 'swap.sh');
    writeFileSync(
      script,
      `#!/bin/bash
# Written by Crew's updater. Waits for Crew to quit, swaps in the new version
# (putting the old one back if that fails) and opens Crew again.
pid="$1"; old="$2"; new="$3"; stage="$4"; reopen="$5"
for _ in $(seq 1 600); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
backup="$old.previous"
rm -rf "$backup"
if mv "$old" "$backup" && mv "$new" "$old"; then
  rm -rf "$backup"
  echo "$(date) updated $old"
else
  echo "$(date) update failed; keeping the old version"
  [ -d "$backup" ] && [ ! -d "$old" ] && mv "$backup" "$old"
fi
rm -rf "$stage"
[ "$reopen" = 1 ] && open "$old"
`,
      { mode: 0o755 },
    );
    mkdirSync(logDir, { recursive: true });
    const log = openSync(join(logDir, 'update.log'), 'a');
    spawn('/bin/bash', [script, String(process.pid), bundle, next, stage, reopen ? '1' : '0'], { detached: true, stdio: ['ignore', log, log] }).unref();
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
  quit();
}

module.exports = { installRelease, cannotInstall, pickZip, runningBundle };
