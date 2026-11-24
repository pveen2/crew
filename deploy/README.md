# Shared conductor

Each Mac runs Crew.app. A remotely managed Cloudflare Tunnel publishes the conductor and SSH on separate hostnames. The conductor runs on Ubuntu 24.04 and listens on 127.0.0.1:4317. The files here target the accounts `admin` and `crew` and the paths in `conductor.env.example`.

## Before merging

Use an owner-approved test hostname on the Cloudflare zone. Create its Access application and MFA policy first, with the binding cookie enabled. Point a named tunnel on the test Mac at a locally running conductor configured with the test AUD, team domain, fixed token and an isolated `CREW_HOME`. Keep its team and engine sign-ins separate from production. Run `corepack pnpm typecheck`, then test the built app with that hostname, including a rejected or expired login, HTTPS, WSS and an Inbox decision by a second identity. The local tests use loopback and test credentials. Run `node --test apps/conductor/test/*.test.mjs`. For Crew.app run `corepack pnpm --filter @crew/mac build`, then `env -u ELECTRON_RUN_AS_NODE apps/mac/node_modules/.bin/electron apps/mac/test/access-smoke.cjs`. Repeat with `--redirect` and `--reject-upgrade` to exercise both recovery paths.

## Access and host creation

1. Confirm the project, region, machine type, IPv4, backups and total cost with the owner. Confirm the team's repo, folder, branch, engines, approved accounts and optional Shopify store. Use temporary provisioning credentials on the admin workstation. The private inputs belong in a password manager.
2. Create two self-hosted Access applications before publishing DNS. On the app hostname include only the approved emails or domain, require the approved MFA-enforcing IdP, choose a 24-hour session and enable the binding cookie. On the SSH hostname include only the owner's exact email, require the same IdP and choose eight hours. Disable one-time PIN for both. If the org uses WARP, require its connection and disk encryption on both policies. Use a separate test with a teammate identity to confirm SSH denial.
3. Create the Hetzner firewall first. Add one temporary TCP/22 rule for the owner's current single IP and leave outbound unrestricted. With `hcloud server create`, attach the firewall at creation, specify the owner's public key, Ubuntu 24.04, confirmed server type and region, public IPv4 and IPv6, and the rendered cloud-init file. Enable provider backups and verify them in the project. For the private cloud-init copy, set the public key and a password hash generated offline for the strong admin console password. Keep the password in the owner's vault. Test a fresh admin SSH session, sudo and web console login before continuing. [Hetzner firewall behavior](https://docs.hetzner.com/cloud/firewalls/overview/)
4. Install Ubuntu security updates, `ufw`, `unattended-upgrades`, `auditd`, `sqlite3`, `curl`, Git, build-essential, Node 24 and Corepack. Enable Corepack and verify `corepack pnpm --version` in the checkout. Set UFW default deny incoming and allow outgoing, enable IPv6, add the same temporary IP-limited SSH rule and enable UFW. Set the host timezone for the backup and reboot hours. Install `52crew-upgrades` in `/etc/apt/apt.conf.d/`, `crew-journal.conf` in `/etc/systemd/journald.conf.d/`, and `crew-audit.rules` in `/etc/audit/rules.d/` after creating `/etc/cloudflared`. Load the audit rules with `augenrules --load`, restart journald and enable persistent logging and security upgrades.

## Tunnel and SSH cutover

Install Cloudflare's cloudflared package with token-file support (2025.4.0 or later). From the admin workstation create the tunnel and its two public hostnames. Route the app hostname's root, `/api/*` and `/ws` paths to `http://127.0.0.1:4317` (path regex `^/($|api/.*$|ws$)`). Route the SSH hostname to `ssh://localhost:22`. End ingress with `http_status:404`. Keep the bridge path local. Create proxied DNS records for the tunnel. Provision the tunnel token into root-owned `/etc/cloudflared/token` (directory 0700, file 0600). Install the reviewed `cloudflared.service` and enable it. The service reads the token file directly. [Tunnel run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/)

Generate an Access SSH CA for the SSH application and install its public key in `/etc/ssh/crew-access-ca.pub`. Write only the owner's verified certificate principal (the email prefix for this mode) into root-owned `/etc/ssh/auth_principals/admin`. Add `TrustedUserCAKeys` and `AuthorizedPrincipalsFile` from `sshd-final.conf` to the bootstrap configuration. Validate with `sshd -t` and reload SSH. On the owner's Mac use the output of `cloudflared access ssh-config --hostname "$SSH_HOST" --short-lived-cert` in SSH config, set `User admin`, and retain its certificate-generation and ProxyCommand lines. [Cloudflare short-lived SSH certificates](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/short-lived-certificates-legacy/)

Keep the bootstrap session open. In a **new** SSH session through Access, verify the owner certificate alone authenticates as admin and sudo works. Then replace the bootstrap drop-in with `sshd-final.conf`, run `sshd -t`, `systemctl daemon-reload` and reload SSH. On Ubuntu with ssh.socket active, restart that socket too. Inspect effective settings with `sshd -T` and inspect both address families with `ss -tulpn`. Reconnect through Access in another new session. Only after this proof, remove the temporary SSH rule from both UFW and the attached Hetzner firewall. Keep the empty firewall attached. Verify there are zero inbound rules and no other attached firewall admits traffic.

## Team, engines and services

Give `crew` no sudo and no SSH login. Set its home and `~/.crew` to 0700 and use umask 077. Use one read-only GitHub deploy key per private repo, separate host aliases with `IdentitiesOnly yes`, and verified GitHub host keys. As `crew`, clone the product on main into `~/crew-app` and the team on the owner's selected branch into `~/team`. Install the product with `corepack pnpm install --frozen-lockfile`. If the team repo needs its own dependencies, install from its lockfile too.

As `crew`, create `~/crew-app/.env.local` with mode 0600 from `conductor.env.example`. Fill in the team folder, the random fixed token, the team hostname, and the app AUD. Keep the port and data paths shown unless updating the paired deployment scripts. Install the team's engine CLIs as `crew`, including agent-browser and its Chromium binary when the browser is used. Install the matching Chromium system libraries as admin. Check paths with `sudo -iu crew bash -lc 'command -v node pnpm claude codex grok agent-browser'` for the selected engines. Install Shopify CLI only for teams using Shopify. Run `pnpm crew login <engine>` from `~/crew-app` for each approved account. The README lists Shopify scopes. Only install agy for a Gemini team and verify its keyring sign-in on headless Linux.

Install privileged files from a reviewed commit in an **admin-controlled checkout**. From its deploy directory:

```sh
sudo install -o root -g root -m 0755 update.sh /usr/local/sbin/crew-update
sudo install -o root -g root -m 0755 backup.sh /usr/local/sbin/crew-backup
sudo install -o root -g root -m 0644 crew-*.service crew-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crew-conductor.service crew-update.timer crew-backup.timer
```

Exercise one real agent turn and its headless browser under the systemd sandbox. When verifying the sandbox on the target image, apply the listed directives incrementally and repeat the two checks at each step. The final unit includes all directives. Run doctor as `crew` using a fresh, user-authenticated app assertion. Obtain it privately on the admin Mac with `cloudflared access token --app "https://$CREW_HOST" | pbcopy`. In the server's interactive Bash shell run the following, pasting the assertion only at the hidden prompt:

```sh
cd ~/crew-app
read -rs -p 'Access assertion: ' assertion
printf '\n'
printf '%s' "$assertion" | pnpm crew doctor --access-stdin
unset assertion
```

The CLI reads the assertion from stdin for HTTP and WebSocket calls. Use the same option for `pnpm crew resume <thread>`. Review each doctor result, including engine and store checks. Record any unused engine separately from a verified sign-in. Clear the clipboard after use.

## Updates and backups

Every two minutes the root unit invokes its installed script. Git, install scripts, typechecking and status reads run as `crew`. A team change refreshes the checkout in place. A product revision is checked in a separate worktree. The updater reads running turns, queues and thread state from SQLite so a timer never needs a human Access JWT. A brief gate rejects new work while the update takes effect. After 30 minutes the update can interrupt a turn. The script checks the new conductor PID and restores the previous revision if startup fails. Review changed deploy scripts and units as admin before installing them. Check logs with `journalctl -u crew-update`.

The nightly job makes a consistent SQLite backup in `/home/crew/backups`. It verifies the copy, publishes it by atomic rename and keeps 14 days. Run `systemctl start crew-backup.service` and open a copy read-only to confirm a known thread is present. Verify both timers with `systemctl list-timers 'crew-*'`. The database backup complements the provider's server backups.

## Acceptance and teammate handover

- Verify an anonymous HTTPS request reaches Access login, then a signed-in request without the Crew token returns 401. On a second Mac, install the released DMG and enter the hostname and password-manager token under **Team > Server**. Sign in, run a thread and approve an item. Verify both identities in its history.
- Merge a harmless product change and a separate team change. Check the server revisions and PID, including a product update during an active turn. Confirm a team-only update changes the next call without restarting the conductor.
- From outside the host, verify all TCP ports on its IPv4 and IPv6 are filtered. Test a fresh certificate-based SSH login as the owner, a denial as a teammate, and console login. Recheck listening sockets, the empty Hetzner firewall, UFW, and `sudo -l -U crew`.
- Revoke the temporary provisioning API tokens on the admin workstation and verify the only Cloudflare credential on the server is the root-only connector token. Hand over the app URL, SSH hostname, verified engine accounts, tested backup and any outstanding checks privately.
