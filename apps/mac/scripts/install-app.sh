#!/bin/zsh
# Puts a double-clickable Crew.app in ~/Applications that runs this checkout:
# it starts the conductor (if it isn't running yet) and the Mac app with live
# reload, so code changes show up without a restart. Run once: `pnpm install-app`
# (or `zsh apps/mac/scripts/install-app.sh <repo>` to point it at another checkout).
# Run it again after moving the repo or changing your PATH.
set -euo pipefail

REPO="${1:-${0:A:h:h:h:h}}"
REPO="${REPO:A}"
DEST="${CREW_APP_DIR:-$HOME/Applications}/Crew.app"
ICON_PNG="$REPO/apps/mac/electron/assets/icon.png"

mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"

cat >"$DEST/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Crew</string>
  <key>CFBundleDisplayName</key><string>Crew</string>
  <key>CFBundleIdentifier</key><string>dev.crew.launcher</string>
  <key>CFBundleExecutable</key><string>crew-launch</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <!-- The launcher stays out of the Dock; the Crew window brings its own icon. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# App icon from the same PNG the window uses.
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$ICON_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$ICON_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$DEST/Contents/Resources/icon.icns"

# Finder starts apps with a bare PATH, so the launcher keeps the one you have now
# (node, pnpm and the claude/codex/grok/agy/shopify CLIs), minus the
# node_modules/.bin entries pnpm adds while running this script.
PATH="${(j/:/)${(@)${(s/:/)PATH}:#*node_modules*}}"
cat >"$DEST/Contents/MacOS/crew-launch" <<LAUNCH
#!/bin/zsh
REPO=${(q)REPO}
export PATH=${(q)PATH}
LAUNCH
cat >>"$DEST/Contents/MacOS/crew-launch" <<'LAUNCH'
CREW_HOME="${CREW_HOME:-$HOME/.crew}"
LOGS="$CREW_HOME/logs"
mkdir -p "$LOGS"
exec >>"$LOGS/app.log" 2>&1
echo "--- $(date) starting Crew from $REPO"

fail() {
  echo "$1"
  osascript -e "display alert \"Crew couldn't start\" message \"$1\n\nDetails: $LOGS/app.log\"" >/dev/null
  exit 1
}

cd "$REPO" 2>/dev/null || fail "The Crew folder isn't at $REPO any more. Run 'pnpm install-app' in its new place."

conductor_pid() {
  local pid
  pid=$(node -e 'try{console.log(require(process.argv[1]).pid)}catch{}' "$CREW_HOME/conductor.json" 2>/dev/null)
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}
STARTED=""
stop_conductor() { [[ -n "$STARTED" ]] && kill -TERM "$STARTED" 2>/dev/null && wait "$STARTED" 2>/dev/null; STARTED=""; }
trap stop_conductor EXIT

# The app's Update button pulls main and quits with code 75: start everything again.
export CREW_LAUNCHER=1
unset ELECTRON_RUN_AS_NODE
while true; do
  # Dependencies: install when missing or when the lockfile changed (after a pull).
  if [[ ! -f node_modules/.modules.yaml || pnpm-lock.yaml -nt node_modules/.modules.yaml ]]; then
    pnpm install --frozen-lockfile || fail "pnpm install failed."
  fi

  # The Dock and menu bar take their name from Electron.app's Info.plist, so run a
  # copy (ditto clones on APFS, no extra space) renamed to Crew with the Crew icon.
  # Rebuilt only when the Electron version changes.
  ELECTRON_SRC=$(node -p "require('path').dirname(require.resolve('electron/package.json', { paths: ['apps/mac'] }))")/dist
  ELECTRON_DIR="$CREW_HOME/electron"
  if [[ "$(cat "$ELECTRON_DIR/source" 2>/dev/null)" != "$ELECTRON_SRC" ]]; then
    rm -rf "$ELECTRON_DIR" && mkdir -p "$ELECTRON_DIR"
    ditto "$ELECTRON_SRC/Electron.app" "$ELECTRON_DIR/Electron.app"
    plist="$ELECTRON_DIR/Electron.app/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleName Crew" "$plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Crew" "$plist" 2>/dev/null ||
      /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Crew" "$plist"
    cp "${0:A:h:h}/Resources/icon.icns" "$ELECTRON_DIR/Electron.app/Contents/Resources/electron.icns"
    # Re-sign only the outer bundle (its Info.plist and icon changed); the code inside is untouched.
    codesign --force --sign - "$ELECTRON_DIR/Electron.app" >/dev/null 2>&1
    echo "$ELECTRON_SRC" >"$ELECTRON_DIR/source"
  fi
  export ELECTRON_OVERRIDE_DIST_PATH="$ELECTRON_DIR"

  # Conductor: reuse a running one, otherwise start it. Not in watch mode: Node's
  # watcher also fires on .git changes (any fetch), and a restart stops running agents.
  # Code changes arrive through the Update button, which restarts everything.
  if [[ -z "$(conductor_pid)" ]]; then
    node --env-file-if-exists=.env.local apps/conductor/src/main.ts >>"$LOGS/conductor.log" 2>&1 &
    STARTED=$!
    for _ in {1..60}; do [[ -n "$(conductor_pid)" ]] && break; sleep 0.5; done
    [[ -n "$(conductor_pid)" ]] || fail "The conductor didn't start. See $LOGS/conductor.log."
  fi

  # App: live reload via Vite, unless another dev server already holds its port
  # (e.g. `pnpm dev` in a worktree); then build once and open that.
  if lsof -nP -iTCP:5317 -sTCP:LISTEN >/dev/null 2>&1; then
    pnpm --filter @crew/mac start
  else
    pnpm --filter @crew/mac dev
  fi
  [[ $? -eq 75 ]] || break
  echo "--- $(date) updated to $(git rev-parse --short HEAD), restarting"
  stop_conductor
done
echo "--- $(date) Crew closed"
LAUNCH
chmod +x "$DEST/Contents/MacOS/crew-launch"

touch "$DEST" # make Finder pick up the new icon
echo "Installed $DEST (runs $REPO)."
echo "Open it from Launchpad/Spotlight or drag it to the Dock. Logs: ~/.crew/logs/"
