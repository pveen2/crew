#!/bin/bash
set -euo pipefail

product=/home/crew/crew-app
candidate=/home/crew/crew-candidate
team=/home/crew/team
state=/var/lib/crew-update
gate=/run/crew-update/activating
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export GIT_TERMINAL_PROMPT=0

# Even Git configuration, hooks and dependency install scripts belong to crew.
as_crew() {
  runuser -u crew -- env HOME=/home/crew /bin/bash -lc 'exec "$@"' crew-update "$@"
}
git_at() { as_crew git -C "$@"; }
pnpm_at() { as_crew env CI=1 corepack pnpm --dir "$@"; }

fetch_head() {
  local repo=$1 branch=$2
  git_at "$repo" fetch --quiet origin "refs/heads/$branch"
  git_at "$repo" rev-parse --verify 'FETCH_HEAD^{commit}'
}

has_manifest_changes() {
  local repo=$1 before=$2 after=$3 result=0
  git_at "$repo" diff --quiet "$before" "$after" -- pnpm-lock.yaml package.json pnpm-workspace.yaml ':(glob)**/package.json' || result=$?
  case $result in
    0) return 1 ;;
    1) return 0 ;;
    *) exit "$result" ;;
  esac
}

install_team() {
  if as_crew test -f "$team/pnpm-lock.yaml"; then
    pnpm_at "$team" install --frozen-lockfile
  elif as_crew test -f "$team/package-lock.json"; then
    as_crew npm --prefix "$team" ci
  elif as_crew test -f "$team/yarn.lock"; then
    as_crew /bin/bash -lc 'cd "$1" && exec corepack yarn install --frozen-lockfile' crew-update "$team"
  elif as_crew test -f "$team/package.json"; then
    pnpm_at "$team" install --no-frozen-lockfile
  fi
}

if (( EUID != 0 )); then echo 'Run from crew-update.service' >&2; exit 1; fi
exec 9>/run/crew-update/update.lock
flock -n 9 || exit 0
trap 'rm -f "$gate"' EXIT

# Root records the last working revision before either checkout moves. Recover also after a reboot.
restore() {
  local repo=$1 marker=$2 old
  read -r old < "$marker"
  [[ $old =~ ^[0-9a-f]{40}$ ]] || exit 1
  echo "Restoring $repo to $old"
  git_at "$repo" reset --hard "$old"
  if [[ $repo == "$team" ]]; then
    install_team
  else
    pnpm_at "$product" install --frozen-lockfile
    systemctl restart crew-conductor.service
  fi
  rm -f "$marker"
}

remember() {
  [[ $2 =~ ^[0-9a-f]{40}$ ]] || exit 1
  echo "$2" > "$1.tmp"
  mv -f "$1.tmp" "$1"
}

if [[ -f $state/team ]]; then restore "$team" "$state/team"; fi
if [[ -f $state/product ]]; then restore "$product" "$state/product"; fi

branch=$(git_at "$team" symbolic-ref --short HEAD)
old=$(git_at "$team" rev-parse HEAD)
next=$(fetch_head "$team" "$branch")
if [[ $old != "$next" ]]; then
  remember "$state/team" "$old"
  git_at "$team" reset --hard "$next"
  if has_manifest_changes "$team" "$old" "$next" ||
     ! git_at "$team" diff --quiet "$old" "$next" -- package-lock.json yarn.lock; then
    if ! install_team; then restore "$team" "$state/team"; exit 1; fi
  fi
  rm -f "$state/team"
  echo "Team updated to $next"
fi

old=$(git_at "$product" rev-parse HEAD)
next=$(fetch_head "$product" main)
if ! as_crew cmp -s "$product/deploy/update.sh" /usr/local/sbin/crew-update; then
  echo 'The checkout updater differs from the installed copy. Review and install it as admin.'
fi
[[ $old != "$next" ]] || exit 0

# Check the candidate in its own tree while agents continue using the active dependencies.
if ! as_crew test -e "$candidate/.git"; then git_at "$product" worktree add --detach "$candidate" "$next"; fi
previous=$(git_at "$candidate" rev-parse HEAD)
if ! as_crew test -f "$candidate/node_modules/.modules.yaml" || has_manifest_changes "$candidate" "$previous" "$next"; then
  as_crew touch "$candidate/.install-pending"
fi
git_at "$candidate" reset --hard "$next"
if as_crew test -e "$candidate/.install-pending"; then
  pnpm_at "$candidate" install --frozen-lockfile
  as_crew rm -f "$candidate/.install-pending"
fi
pnpm_at "$candidate" typecheck

busy() {
  local count
  count=$(as_crew sqlite3 -readonly -batch -cmd '.timeout 5000' /home/crew/.crew/crew.db \
    "SELECT EXISTS(SELECT 1 FROM turns WHERE status='running' UNION ALL SELECT 1 FROM sessions WHERE status='queued' UNION ALL SELECT 1 FROM threads WHERE status='running');") || exit 1
  case $count in 1) return 0 ;; 0) return 1 ;; *) exit 1 ;; esac
}
deadline=$((SECONDS + 1800))
while (( SECONDS < deadline )); do
  if ! busy; then
    touch "$gate"
    # Let the conductor finish any synchronous handler that already passed the gate.
    as_crew curl --silent --show-error --output /dev/null --max-time 5 http://127.0.0.1:4317/
    if ! busy; then break; fi
    rm -f "$gate"
  fi
  sleep 5
done
touch "$gate"
if (( SECONDS >= deadline )); then echo 'Waited 30 minutes for running turns. Activating the update.'; fi
remember "$state/product" "$old"
git_at "$product" reset --hard "$next"
if has_manifest_changes "$product" "$old" "$next"; then
  if ! pnpm_at "$product" install --frozen-lockfile; then restore "$product" "$state/product"; exit 1; fi
fi
if systemctl restart crew-conductor.service; then
  # Confirm the new process reached listen(), rather than accepting systemd's spawn as success.
  for _ in {1..30}; do
    pid=$(systemctl show --value -p MainPID crew-conductor.service)
    if [[ $pid =~ ^[1-9][0-9]*$ ]] && as_crew node -e \
      'const fs = require("node:fs"); const info = JSON.parse(fs.readFileSync("/home/crew/.crew/conductor.json")); process.exit(info.pid === Number(process.argv[1]) ? 0 : 1)' "$pid"; then
      rm -f "$state/product"
      echo "Conductor updated to $next"
      if ! as_crew cmp -s "$product/deploy/update.sh" /usr/local/sbin/crew-update; then echo 'Review the changed updater and install it as admin.'; fi
      exit 0
    fi
    sleep 1
  done
fi
restore "$product" "$state/product"
exit 1
