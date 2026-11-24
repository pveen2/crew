# Briefing: Crew conductor on a Hetzner server, behind Cloudflare Access

You are setting up Crew so a whole team can use one conductor from their own
Crew.app, signing in through Cloudflare Access. Work in two parts: **A** is code
in the `pveen2/crew` repo (one PR), **B** is the server. Do A first; B needs it.

Read `README.md` in the repo before starting. Key facts you need from it:

- `apps/conductor` is the server: HTTP + WebSocket on `127.0.0.1:${CREW_PORT:-4317}`,
  SQLite at `$CREW_HOME/crew.db`, session folders under `$CREW_HOME/sessions`.
  It runs TypeScript directly on Node 24 (`node src/main.ts`), no build step.
- Agents run on the official CLIs (`claude`, `codex`, `grok`, `agy`) signed in
  with `pnpm crew login <engine>`; sign-ins live in `$CREW_HOME/engines/`.
- The team (agents, instructions, skills) is a folder, usually `crew/` in a
  separate repo. The conductor finds it through `CREW_TEAM_DIR`. Team files are
  re-imported on every call (`packages/sdk/src/load.ts`), and a team repo needs
  nothing installed (`packages/sdk/src/resolve.ts`).
- Crew.app can already use a remote conductor: `~/.crew/app.json` with
  `{ "conductorUrl": "https://…", "token": "…" }` (`apps/mac/electron/main.cjs`, `conductorInfo()`).

## Target

```
Crew.app (each teammate) ──HTTPS/WSS──► Cloudflare Access ──► Cloudflare Tunnel
   ──► cloudflared on the Hetzner server ──► conductor on 127.0.0.1:4317
```

- **No inbound ports at all**, not even SSH. Both the app and SSH reach the
  server only through an outbound Cloudflare Tunnel, behind Cloudflare Access.
  See "Security baseline" below; it overrides anything looser in this file.
- Merging to `main` in `pveen2/crew` or to the team repo's branch updates the
  server automatically. No Vercel: it can't run a long-lived process with
  WebSockets, local CLIs and SQLite, and isn't needed.

## Ask the owner for (do not guess, never put these in git or chat logs)

1. Hetzner Cloud API token (read & write) and which project to use.
2. The hostname, e.g. `crew.<their-domain>`, and that the domain is on Cloudflare.
3. Cloudflare: an API token with *Account: Cloudflare Tunnel: Edit*, *Account:
   Access: Apps and Policies: Edit*, *Zone: DNS: Edit*, **or** they run
   `cloudflared tunnel login` themselves and create the Access app in the dashboard.
4. Who may sign in: an email domain (e.g. `@askphill.com`) and/or a list of emails.
5. The team repo, folder and branch (e.g. `askphill/wakey`, `crew`, `main`), and a
   read-only GitHub deploy key or fine-grained token for the server to pull it
   (and `pveen2/crew` if it is private).
6. Shopify store (if the team uses one).
7. Confirmation before anything that costs money (creating the server).
8. **Subscriptions:** Crew runs on the owner's own CLI subscriptions. Sharing a
   personal Claude/ChatGPT plan with a whole team likely breaks those plans'
   terms. Ask which accounts to sign the engines in with (team/business plans
   or API keys). Do not decide this yourself.

---

## Security baseline (non-negotiable)

The owner wants this as secure as reasonably possible. Apply all of it; if
something here can't be done, stop and ask instead of loosening it.

**Network**

- Hetzner Cloud Firewall attached at creation: **no inbound rules** (all
  inbound dropped, IPv4 and IPv6). Outbound open (agents, GitHub, Cloudflare,
  model APIs need it). Mirror it with `ufw default deny incoming`.
- Keep the public IPv4: GitHub has no IPv6, so an IPv6-only server can't pull.
  It is not reachable anyway because of the firewall.
- **SSH only through Cloudflare:** a second public hostname on the same tunnel,
  `ssh.<domain>` → `ssh://localhost:22`, with its own Access application
  (owner's email only, not the team). Prefer Access short-lived SSH
  certificates (Access → Service auth → SSH: put the CA public key in
  `TrustedUserCAKeys`, map Access emails to the `admin` user). The owner
  connects with `cloudflared access ssh` in their `~/.ssh/config`
  (`ProxyCommand cloudflared access ssh --hostname %h`).
- **Order matters, so you don't lock yourself out:** at creation, allow 22/tcp
  only from the owner's current IP. Set up the tunnel and SSH-over-Access, prove
  it works in a *new* session, **then** delete the 22 rule. Break-glass access is
  the Hetzner web console (set a strong password for `admin`, stored in the
  owner's password manager; SSH itself never accepts passwords).
- `sshd`: `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
  `PermitRootLogin no`, `AllowUsers admin`, `ListenAddress 127.0.0.1` and `::1`
  once SSH goes only through the tunnel.

**Cloudflare Access**

- Policies: *Allow* on the email list/domain **and** *Require* an identity
  provider with MFA (Google Workspace or the org's IdP, with 2-step verification
  enforced). Don't use one-time PIN alone. Optionally *Require* country.
- Session duration: app 24h, SSH 8h. Turn on "Binding cookie" for the app.
- If the team uses WARP: add a device-posture requirement (WARP connected,
  disk encryption on) to both apps.
- Tunnel: run it with a tunnel **token** stored root-only (`/etc/cloudflared`,
  mode 600), not a `cert.pem` on the box.

**Users and secrets**

- Users: `admin` (SSH, sudo) and `crew` (runs the conductor, **no sudo, no
  SSH login**: `AllowUsers` excludes it, shell kept only for `bash -lc`).
- The agents run as `crew` with shell tools, so assume an agent can read
  anything `crew` can. So: no sudo for `crew`, nothing secret in `crew`'s
  home except what the conductor needs (`.env.local` and `~/.crew`, mode 600/700),
  read-only deploy keys only, no Cloudflare or Hetzner tokens on the server.
- The update job runs as **root** (B7) and drops to `crew` for git/pnpm with
  `runuser -u crew --`. That way `crew` never needs sudo.
- Delete the Hetzner and Cloudflare API tokens (or ask the owner to) once setup
  is finished. The GitHub access is a **read-only deploy key** per repo.

**System**

- Ubuntu 24.04 LTS, `unattended-upgrades` with security updates and automatic
  reboot at a quiet hour (e.g. 04:00). The conductor and cloudflared come back
  on their own (systemd `enable`).
- `fail2ban` isn't needed with no open ports; skip it.
- `auditd` with basic rules (sshd config, sudoers, `/etc/cloudflared`), and
  journald persistent storage.
- systemd sandboxing for `crew-conductor.service`: `NoNewPrivileges=yes`,
  `PrivateTmp=yes`, `ProtectSystem=full`, `ProtectKernelTunables=yes`,
  `ProtectKernelModules=yes`, `ProtectControlGroups=yes`,
  `RestrictSUIDSGID=yes`, `LockPersonality=yes`. Don't set `ProtectHome`
  (the CLIs live in and write to `crew`'s home). Test that agents and the
  headless browser still work after adding each option.
- Conductor stays on `127.0.0.1` (it already does). Verify nothing else listens
  publicly: `ss -tulpn` shows only loopback addresses.

**Checks before handing over**

- `nmap -Pn -p- <server IPv4>` and the IPv6 address from outside: everything
  filtered.
- `crew.paul.studio` without Access login → Cloudflare login page; signed in
  without the token → 401.
- `ssh.<domain>` works for the owner, is refused for a teammate's email.
- Hetzner console login works (break-glass).

---

## Part A: code changes (PR to `pveen2/crew`)

Branch from `main`. Keep the repo's style (plain short comments, no new
dependencies unless needed). Run `pnpm typecheck` before opening the PR.

### A1. Fixed token

`apps/conductor/src/main.ts` makes a random token on every start, so a remote
app loses access after each restart. Use `process.env.CREW_TOKEN` when set
(require at least 32 characters, fail at start otherwise); keep the random
token when it is unset. Document `CREW_TOKEN` in `.env.example`.

### A2. Trust Cloudflare Access (per-person identity)

When `CREW_ACCESS_TEAM_DOMAIN` (e.g. `askphill.cloudflareaccess.com`) and
`CREW_ACCESS_AUD` (the Access application's AUD tag) are set:

- In `apps/conductor/src/server.ts`, on every `/api/*` request and on the `/ws`
  upgrade, verify the `Cf-Access-Jwt-Assertion` header: RS256 signature against
  `https://<team-domain>/cdn-cgi/access/certs` (cache the keys, refetch on
  unknown `kid`), `aud` contains the AUD, `iss` is `https://<team-domain>`, not
  expired. Use `node:crypto` (`createPublicKey({ key: jwk, format: 'jwk' })`);
  no JWT library needed.
- Reject when it fails. Still require the bearer/`?token=` as well (defence in
  depth); the token can then be shared with the team safely.
- Read `email` from the verified JWT and make it available to the request
  handlers. Leave `/internal/tool` alone: it is called from 127.0.0.1 by the MCP
  bridge with its own per-session token.

### A3. Record who did what

Add a nullable `by_email` (or similar) to what the owner does: starting a
thread, sending a message, approving/denying an Inbox item. Store it in
`apps/conductor/src/db.ts` (add a migration the way existing columns were
added), expose it in `packages/protocol`, and show it in the app where the
author/approver is shown. Keep it small; null when not behind Access.

### A4. Crew.app through Cloudflare Access

The renderer is loaded from `file://` and the conductor sends
`access-control-allow-origin: *`, so the browser will not attach Cloudflare's
`CF_Authorization` cookie. Fix it in the Electron main process
(`apps/mac/electron/main.cjs`), only when `conductorUrl` is not 127.0.0.1:

1. Before connecting, if there is no valid Access cookie for the conductor's
   host, open a `BrowserWindow` at `conductorUrl` so the person signs in through
   Cloudflare's own page. Close it once the `CF_Authorization` cookie for that
   host appears in the window's session (`session.cookies`).
2. With `session.defaultSession.webRequest.onBeforeSendHeaders` filtered to
   `https://<host>/*` and `wss://<host>/*`, add header
   `cf-access-token: <cookie value>` to every request.
3. When a request comes back 401/403 or redirects to `*.cloudflareaccess.com`,
   clear the cookie and show the sign-in window again.
4. Add a way to set the remote conductor from the app (Team screen: "Server" with
   URL + token, saved to `~/.crew/app.json`) so teammates don't edit JSON.

Test locally with `cloudflared` pointing at a local conductor before merging.

### A5. Server scripts in the repo

Add `deploy/` with the files from Part B (systemd units, update script, env
example) so the setup is reviewable and the update script updates itself.

---

## Part B: the server

### B1. Create it (after the owner confirms the cost)

- Hetzner Cloud, Ubuntu 24.04, **CAX21** (4 vCPU ARM, 8 GB) or **CX32**. Agents
  plus headless Chromium need the memory. Location near the team (e.g. `fsn1`/`nbg1`).
- Add the owner's SSH key. Enable Hetzner backups (plus the nightly `crew.db` copy in B7).
- Hetzner Cloud Firewall: at first only 22/tcp from the owner's current IP;
  **no inbound at all** once SSH over Cloudflare works (see Security baseline).
- Use `hcloud` CLI with the API token.

### B2. Base setup

- Users `admin` and `crew` as in the Security baseline; root login and
  passwords off for SSH.
- `unattended-upgrades`, `ufw default deny incoming`, `auditd`.
- Node 24 (NodeSource or `fnm`), `corepack enable` → pnpm 10, git, build-essential.
- The CLIs the team's agents use, as user `crew`: `claude`, `codex`, `grok`
  (`curl -fsSL https://x.ai/cli/install.sh | bash`), `agent-browser` (plus
  Chromium's system libraries: `npx playwright install-deps chromium` or the
  agent-browser docs), `shopify` if needed. Check each is on the login-shell
  PATH of `crew` (`bash -lc 'which claude codex grok'`): the conductor reads
  PATH from `$SHELL -lc`.
- **Antigravity (`agy`, Gemini) is unverified on headless Linux**: it stores its
  sign-in in a system keyring. Only set it up if the team uses Gemini agents,
  and report back if sign-in fails.

### B3. Code and team

As `crew`:

```sh
git clone https://github.com/pveen2/crew.git ~/crew-app      # product
git clone <team repo> ~/team                                 # team, at the owner's branch
cd ~/crew-app && pnpm install --frozen-lockfile
```

`/home/crew/crew-app/.env.local` (mode 600):

```sh
CREW_HOME=/home/crew/.crew
CREW_TEAM_DIR=/home/crew/team/<team folder, e.g. crew>
CREW_PORT=4317
CREW_TOKEN=<openssl rand -base64 36>
CREW_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
CREW_ACCESS_AUD=<Access app AUD tag>
# SHOPIFY_STORE=<store>.myshopify.com
```

### B4. Sign in

SSH in as `admin`, switch with `sudo -iu crew`, then from `~/crew-app`: `pnpm crew login claude` (and `codex`,
`grok` as needed). These print a URL/code: give it to the owner to open, using
the accounts they chose (see "Ask the owner" #8). Then `shopify store auth
--store … --scopes …` (scopes in README). Finish with `pnpm crew doctor`;
everything it checks must pass.

### B5. Run the conductor (systemd)

`/etc/systemd/system/crew-conductor.service`:

```ini
[Unit]
Description=Crew conductor
After=network-online.target
Wants=network-online.target

[Service]
User=crew
WorkingDirectory=/home/crew/crew-app
Environment=SHELL=/bin/bash
ExecStart=/usr/bin/env bash -lc 'exec node --env-file=.env.local apps/conductor/src/main.ts'
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
# Sandboxing: see Security baseline. Test agents + browser after adding.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
```

Enable and start it. Check `curl -s -H "authorization: Bearer $CREW_TOKEN"
http://127.0.0.1:4317/api/state` returns JSON. (After A2 this needs the Access
header too; test that through the tunnel.)

### B6. Cloudflare Tunnel + Access

- Install `cloudflared`, create a remotely managed tunnel, and run it with its
  token (`cloudflared service install <token>`). Public hostnames:
  `crew.paul.studio` → `http://127.0.0.1:4317` and `ssh.<domain>` → `ssh://localhost:22`.
  WebSockets work through tunnels by default.
- Zero Trust → Access → Applications → self-hosted app on `crew.paul.studio` for
  the team and a separate one on `ssh.<domain>` for the owner only, with the
  policies from the Security baseline (MFA identity provider, no PIN-only,
  binding cookie). Copy the app's **AUD tag**
  into `.env.local` (`CREW_ACCESS_AUD`) and restart the conductor.
- Check from outside: without signing in you get the Access login page; after
  signing in, `/api/state` without the token is 401, with the token is 200.

### B7. Auto-update on merge

Use a **pull** on the server, not a push from GitHub: no inbound SSH from
GitHub's runners, no server keys stored in GitHub. A merge is live within ~2
minutes.

`deploy/update.sh`, every 2 minutes from a systemd timer
(`crew-update.service` + `crew-update.timer`, `OnUnitActiveSec=2min`). The
service runs as **root**; every git/pnpm/curl step runs as `crew` through
`runuser -u crew --`, and only the restart runs as root. Install the script
to `/usr/local/sbin/crew-update` (root-owned, 755), not from `crew`'s checkout,
or an agent could edit what root runs. When `deploy/update.sh` changes in the
repo, log it and leave the copy alone; the owner updates it over SSH.

1. **Team repo:** `git -C ~/team fetch origin <branch>`; if `HEAD` differs from
   `origin/<branch>`, `git reset --hard origin/<branch>` (the server never edits
   it). No restart needed: team files are re-imported on every call. If the team
   repo has its own `package.json`/lockfile that changed, run its install too.
2. **Product repo:** `git -C ~/crew-app fetch origin main`; if behind:
   - `git reset --hard origin/main`; if `pnpm-lock.yaml` changed,
     `pnpm install --frozen-lockfile`.
   - `pnpm typecheck`; if it fails, go back to the previous commit, log it, and
     stop (don't restart onto broken code).
   - **Wait until no agent is working**: poll `/api/state` (with token, from
     127.0.0.1) until no thread has status `running`. Give up waiting after
     30 min and restart anyway. A restart interrupts running turns; they are
     marked interrupted and can be resumed (`pnpm crew resume <thread>`).
   - `systemctl restart crew-conductor` (as root, from the update service).
3. Use a lock file (`flock`) so two runs never overlap. Log to the journal.

Optional later: a GitHub Action on `main` that runs `pnpm typecheck` so broken
code is caught before the merge, not just before the restart.

Backups: a daily timer that runs
`sqlite3 ~/.crew/crew.db ".backup ~/backups/crew-$(date +%F).db"` and keeps 14
days, on top of Hetzner backups.

### B8. Teammates

Give each teammate:

1. Crew.app (DMG from Releases).
2. Team screen → Server: `https://crew.paul.studio` and the `CREW_TOKEN` (share it
   through a password manager). Before A4's Server field ships:
   `~/.crew/app.json` → `{ "conductorUrl": "https://crew.paul.studio", "token": "…" }`.
3. First launch opens the Cloudflare sign-in.

Teammates don't install or sign in to any engine CLI themselves; the server does
the work.

## Done when

- [ ] PR for Part A merged; `pnpm typecheck` passes.
- [ ] `pnpm crew doctor` passes on the server.
- [ ] From outside: Access login required; without token → 401; Crew.app on a
      second Mac connects, shows the team, and a thread runs end to end.
- [ ] Approving an Inbox item from Crew.app records the approver's email.
- [ ] A trivial commit merged to `main` shows up on the server within ~2 min and
      the conductor restarted only after running turns finished.
- [ ] A change merged to the team repo is live without a restart.
- [ ] No open ports from outside (`nmap -Pn -p-`, IPv4 and IPv6); SSH works only
      via `ssh.<domain>` through Access; Hetzner console works as break-glass.
- [ ] `crew` has no sudo and can't log in over SSH; no Cloudflare/Hetzner tokens
      left on the server; API tokens deleted or handed back to the owner.
- [ ] Backups run.

Report back to the owner: the URL, how teammates connect, which accounts the
engines are signed in with, and anything that did not work (especially `agy`).
