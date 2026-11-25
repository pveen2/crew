#!/bin/bash
# Installs the latest Crew Mac app without the Gatekeeper prompts:
#
#   curl -fsSL https://raw.githubusercontent.com/pveen2/crew/main/scripts/install-mac.sh | bash
#
# A file curl downloads carries no quarantine flag, so macOS opens the app
# straight away (a browser download of the same DMG gets the "unidentified
# developer" warning until the app is signed and notarized). Run it again to
# update.
set -euo pipefail

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "Crew runs on Macs with Apple silicon or Intel." >&2; exit 1 ;;
esac
# The latest release's DMGs: Crew-<version>-arm64.dmg and Crew-<version>.dmg (Intel).
if [ "$arch" = arm64 ]; then pattern='Crew-[0-9.]*-arm64\.dmg'; else pattern='Crew-[0-9.]*\.dmg'; fi
url=$(curl -fsSL https://api.github.com/repos/pveen2/crew/releases/latest |
  grep -o '"browser_download_url": *"[^"]*"' | grep -o "https://[^\"]*/$pattern" | head -n1 || true)
[ -n "$url" ] || { echo "Could not find the latest Crew release. See https://github.com/pveen2/crew/releases" >&2; exit 1; }

dest=/Applications
[ -w "$dest" ] || dest="$HOME/Applications"
mkdir -p "$dest"

tmp=$(mktemp -d)
mnt="$tmp/mnt"
cleanup() { hdiutil detach -quiet "$mnt" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT

echo "Downloading Crew ($arch)…"
curl -fL --progress-bar -o "$tmp/Crew.dmg" "$url"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mnt" "$tmp/Crew.dmg"

if pgrep -xq Crew; then
  echo "Quitting the running Crew…"
  osascript -e 'quit app "Crew"' 2>/dev/null || true
  sleep 2
fi
rm -rf "$dest/Crew.app"
ditto "$mnt/Crew.app" "$dest/Crew.app"
# In case the app arrived some other way before: drop any quarantine flag.
xattr -dr com.apple.quarantine "$dest/Crew.app" 2>/dev/null || true

echo "Installed $dest/Crew.app"
open "$dest/Crew.app"
