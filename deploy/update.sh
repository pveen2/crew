#!/bin/bash
# Installed as /usr/local/sbin/crew-update (root-owned) and run by
# crew-update.timer. Pulls the team and Crew itself from GitHub:
# - team changes are live at once (team files are read on every call);
# - Crew changes are typechecked, then the conductor restarts once no agent
#   is working (or after 30 minutes).
# This copy in the repo is not what runs: an agent could edit the checkout,
# so root only runs the copy in /usr/local/sbin. Update that by hand.
set -euo pipefail
exec 9>/run/crew-update.lock
flock -n 9 || exit 0

APP=/home/crew/crew-app
TEAM_REPO=${TEAM_REPO:-/home/crew/team}
TEAM_BRANCH=${TEAM_BRANCH:-main}
as_crew() { runuser -u crew -- bash -lc "$*"; }
log() { echo "[crew-update] $*"; }

# The team: plain fast-forward to the branch, no restart.
if [ -d "$TEAM_REPO/.git" ]; then
  as_crew "git -C '$TEAM_REPO' fetch -q origin '$TEAM_BRANCH'"
  if [ "$(as_crew "git -C '$TEAM_REPO' rev-parse HEAD")" != "$(as_crew "git -C '$TEAM_REPO' rev-parse 'origin/$TEAM_BRANCH'")" ]; then
    as_crew "git -C '$TEAM_REPO' reset -q --hard 'origin/$TEAM_BRANCH'"
    log "team updated to $(as_crew "git -C '$TEAM_REPO' rev-parse --short HEAD")"
  fi
fi

# Crew itself.
as_crew "git -C '$APP' fetch -q origin main"
OLD=$(as_crew "git -C '$APP' rev-parse HEAD")
NEW=$(as_crew "git -C '$APP' rev-parse origin/main")
[ "$OLD" = "$NEW" ] && exit 0

log "crew ${OLD:0:7} -> ${NEW:0:7}"
as_crew "cd '$APP' && git reset -q --hard origin/main"
if ! as_crew "cd '$APP' && { git diff --quiet '$OLD' HEAD -- pnpm-lock.yaml || pnpm install --frozen-lockfile --reporter=silent; } && pnpm -s typecheck"; then
  log "install or typecheck failed on ${NEW:0:7}; staying on ${OLD:0:7}"
  as_crew "cd '$APP' && git reset -q --hard '$OLD' && pnpm install --frozen-lockfile --reporter=silent"
  exit 1
fi
if [ "$(as_crew "git -C '$APP' diff --quiet '$OLD' HEAD -- deploy/update.sh && echo same")" != same ]; then
  log "deploy/update.sh changed in the repo; install it by hand (see docs/server-briefing.md)"
fi

# Wait until no agent turn is running (max 30 min), then restart. Read from the
# database (read-only): the API needs a Cloudflare Access login.
DB=/home/crew/.crew/crew.db
for _ in $(seq 1 180); do
  RUNNING=$(sqlite3 -readonly -cmd ".timeout 5000" "$DB" "SELECT count(*) FROM turns WHERE status = 'running'" 2>/dev/null || echo 0)
  [ "${RUNNING:-0}" = 0 ] && break
  sleep 10
done
systemctl restart crew-conductor
log "restarted on ${NEW:0:7}"
