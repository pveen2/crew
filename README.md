# Crew

A digital team for a business: a GM and specialist AI agents that run on the
official **Claude Code**, **Codex**, **Grok Build** and **Google Antigravity**
CLIs, signed in with the owner's own subscriptions. You work with them in a Mac
app where every question is its own thread, and approve every change to a live
system from an Inbox.

This repo is the product. A team (its agents, instructions, skills and evals)
is a folder you keep with the business, for example `crew/` in the brand's own
monorepo. `crew/` here is a small example team: a GM and a Web researcher.

Status: early. Read and draft only; everything runs on your own machine.

```
apps/conductor   local server: sessions, subagent calls, approvals, events, SQLite, WebSocket
apps/mac         Electron + React app (display only, no agent logic)
crew/            an example team, eve-style: crew.config.ts, agent/ (lead), agent/subagents/, lib/, evals/
packages/sdk     @crew/sdk: defineAgent, defineTool, defineCrew, evals and the team loader
packages/kit     @crew/kit: ready-made Shopify, headless browser and X search connections
packages/protocol shared types for events and the API
packages/ui      the Crew design system (tokens + React components)
scripts/crew.ts  the `pnpm crew` command
scripts/try.ts   model comparison page
```

## Setup

Node 24+ and pnpm 10, plus the `claude`, `codex`, `grok`, `agy`, `agent-browser` and `shopify`
CLIs on your PATH (Grok Build: `curl -fsSL https://x.ai/cli/install.sh | bash`;
Antigravity: `curl -fsSL https://antigravity.google/cli/install.sh | bash`).

```sh
pnpm install
cp .env.example .env.local
pnpm crew login claude            # signs Claude Code in for Crew only
pnpm crew login codex             # signs Codex in for Crew only
pnpm crew login grok              # signs Grok Build in for Crew only
pnpm crew login antigravity       # Google sign-in for Gemini models, then /quit
shopify store auth --store <your-store>.myshopify.com --scopes read_products,read_inventory,read_orders,read_customers,write_products,write_inventory
pnpm crew doctor                  # checks sign-in, team, Shopify, conductor
```

Crew keeps its own engine config folders in `~/.crew/engines/{claude,codex,grok,antigravity}`
(`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME`, and `HOME` for Antigravity). Codex and Grok also read
personal files from your home folder whatever those variables say (Codex:
`~/.agents/skills`; Grok: `~/.claude`, `~/.cursor`, `~/.agents`), so their Crew
sessions also run with their own empty `HOME`, and Crew switches off Grok's
Claude/Cursor compatibility scanning. Agents never see your personal settings,
skills, MCP servers or history. Each session works only in its own folder,
`~/.crew/sessions/<thread>/<agent>-<id>/`.

Gemini models (Gemini 4 Neon and others) run on the Google Antigravity CLI
(`agy`) with the owner's Google subscription: Google AI Pro or Ultra, or
Gemini Enterprise ("Use Business Account"). Plain Google Workspace plans do
not include Antigravity, and Google no longer serves subscriptions through the
Gemini CLI. The sign-in sits in the macOS keychain; Crew runs `agy` with its
own `HOME` so personal Antigravity settings, MCP servers and skills stay out.
Models: `agy models` (for example `antigravity/gemini-4-neon-high`).

Grok models: `grok-4.6` (default) and `grok-4.5`. Set `model: 'grok/grok-4.6'` in an
agent's `agent.ts`, or compare with `pnpm crew try <agent> "…" --models grok/grok-4.6,claude-code/opus`.

The store manager uses the Shopify CLI's stored authentication. Run the
Shopify auth command again if authentication expires. The team's store is
`shopify.store` in `crew/crew.config.ts`; `SHOPIFY_STORE` in the conductor
environment overrides it (authenticate for that store with the same scopes).
The doctor checks the team's store.

## Run

```sh
pnpm dev                          # conductor + Mac app together (Turborepo)
# or separately:
pnpm conductor
pnpm app
```

**Without a terminal:** run `pnpm install-app` once. It puts **Crew.app** in
`~/Applications` (find it with Spotlight or drag it to the Dock). Double-click
it to start the conductor (unless one is already running) and the app with live
reload, which installs dependencies first when the lockfile has changed. Quitting the app
stops the conductor it started. It runs the checkout you installed it from;
logs are in `~/.crew/logs/`. Run `pnpm install-app` again after moving the repo.
When that checkout is on a clean `main` and GitHub has newer commits, the
sidebar shows **Update Crew**: it pulls `main` and restarts Crew.

**Installed app (DMG).** Everything in one app, nothing else to install
first:

1. Download `Crew-<version>-arm64.dmg` (Apple silicon) or `Crew-<version>.dmg`
   (Intel) from [Releases](https://github.com/pveen2/crew/releases), open it
   and drag Crew to Applications.
2. Open Crew. Until releases are signed by Apple, macOS asks once: System
   Settings → Privacy & Security → **Open Anyway**.
3. In the sidebar, install and sign in to the engines your agents use
   (Claude Code at least). Each opens Terminal with the right command.

The app brings its own conductor and runs it on its built-in Node; it starts
and stops with the app. Choose the team on the **Team** screen (click the team
name at the top of the sidebar):

- **From GitHub**: a repo, the team folder in it and a branch, for example
  `askphill/wakey`, `crew`, `main`. Crew keeps its own copy in `~/.crew/teams`
  (made with your git sign-in) and shows **Update team** in the sidebar when
  the team folder, or a brand file its `crew.config.ts` points at, changes on
  that branch. One click updates and restarts the conductor.
- **Folder on this Mac**: run a folder as it is; you keep it up to date.
- **Example team**: the GM and Web researcher in this repo.

A team needs nothing installed: when its files import `@crew/sdk`, `@crew/kit`
or `zod` and its repo lacks them, Crew supplies its own. The settings live in
`~/.crew/app.json`, which also takes extra environment for the conductor
(`"env": { "SHOPIFY_STORE": "…" }`) or at a conductor elsewhere with `{ "conductorUrl": "https://…", "token": "…" }`.
A conductor that is already running (`pnpm conductor`) is used as it is.

Updates come from GitHub Releases, checked at start and every four hours. When
one is out the sidebar shows **Update Crew**: click it and Crew downloads the
new version, checks it, installs it and restarts, like any Mac app (agents that
are working stop for the restart). Until releases are signed by Apple, Crew
installs updates itself; once signed, it uses Apple's updater. Crew must be in
a folder it can write to, such as Applications.

From the terminal (no app needed):

```sh
pnpm crew ask "Welke producten zijn uitverkocht?"     # new thread, follows it live
pnpm crew send <threadId> "Antwoord op je vraag…"     # --session <id> to step in
pnpm crew resume <threadId>                           # after a restart
pnpm crew status                                      # threads, Inbox, who is working
pnpm crew show <threadId>
pnpm crew approve <inboxId>                           # or: deny <inboxId>
pnpm crew info                                        # what Crew found in the team folder
pnpm crew translate store-manager claude-code         # what an agent becomes per engine
pnpm crew try store-manager "Welke producten zijn bijna uitverkocht?" \
  --models claude-code/opus,claude-code/sonnet,codex/gpt-6.2-sol@high
pnpm crew eval [filter] [--repeat 3] [--strict]       # run the team's evals/
pnpm crew report                                      # time, handoffs, verdicts per thread
pnpm crew verdict <threadId> --quality 4 --app 3 "note"
```

## How it works

**The product and the team are separate.** `apps/` and `packages/` are the
product (the same for every brand). The team folder is one brand's agents. Here
it is `crew/`; elsewhere, point the conductor at any folder with
`CREW_TEAM_DIR` (a brand's own monorepo keeps its team in its own `crew/`).

**The team folder** follows [eve](https://eve.dev)'s layout. Names come from
paths; there is no registry. Run `pnpm crew info` to see what was found.

```
crew.config.ts                 defineCrew({ name, shopify: { store }, brand: 'lib/brand' })
agent/                         the lead (GM): owns every thread
  agent.ts                     defineAgent({ model: 'claude-code/opus', approval, limits })
  instructions.md
  tools/<name>.ts              defineTool (file name = tool name, snake_case)
  skills/<name>/SKILL.md       or skills/<name>.ts → sharedSkill('<name>') from lib/skills
  memory/preferences.ts        defineMemory: standing owner preferences
  subagents/<name>/            one folder per specialist, same layout
    agent.ts                   defineAgent({ description, model: 'codex/gpt-6.2-sol@medium' })
    connections/shopify.ts     export default shopifyConnection({ store }) (from @crew/kit/shopify)
lib/                           shared: rules.md, brand/, skills/, store.ts
evals/**/<name>.eval.ts        defineEval, plus evals.config.ts
```

- `model` is `<engine>/<model>[@reasoning]`: the one difference from eve,
  because Crew runs on the official CLIs with the owner's subscriptions.
- **Subagents inherit nothing** from the lead. Shared pieces are factories
  (`@crew/kit`: Shopify, the headless browser, X search) used from a one-line
  file, so a connection's allow-list cannot drift.
  `lib/rules.md` (Crew's own rules) and `lib/brand/` go to every agent.
- **One level of delegation.** The lead gets one tool per subagent
  (`store_manager(message)`). A specialist
  starts fresh with only the brief and does not delegate further.
- **Artifacts by id.** Specialists save long work with `save_artifact` and
  return the id with a short summary. The lead shows it as it is with
  `show_preview(artifactId)` or passes the id to the next specialist, so long
  drafts never fill the lead's context and are not rewritten.
- **Memory.** `agent/memory/preferences.ts` gives the lead
  `preferences__save_memory` / `preferences__remove_memory`. Entries are kept in
  `crew.db` and recalled into the lead's `AGENTS.md` every turn. Specialists
  do not see it; the lead puts what matters in the brief.
- **Approvals.** An agent's `approval({ toolName, input })` callback (or a
  tool's own `approval: 'user-approval'`) returns `'user-approval'` to pause the
  call, or `'deny'`. The call waits for the owner in the Inbox (app, or
  `pnpm crew approve|deny <id>`). The lead requires approval to forget a
  memory. External MCP connections cannot be paused mid-call; they are limited
  with `tools: { allow: [...] }`.
- **Evals** start a real thread on the running conductor, wait, then check it:
  `t.succeeded()`, `t.delegatedTo('store-manager')`, `t.calledTool('save_artifact', { by })`,
  `t.notDelegated()`, `t.answerMatches()`, `t.check()`, and `await t.judge(rubric)`.
  Checks are gates unless `{ soft: true }`; the judge is soft by default and
  runs on a CLI too (`evals.config.ts`). Results go to `~/.crew/evals/`.

Brand documents go in the team's `lib/brand/` (or the folder `brand` names in
`crew.config.ts`). Every session gets a read-only copy in `context/brand/`.

**Translation** (`apps/conductor/src/translate.ts`) writes the same files for
every engine into each session folder. No `CLAUDE.md` and no `.claude/`:

| | All engines |
| --- | --- |
| Instructions | `AGENTS.md`: `lib/rules.md` + the agent's instructions + its tools, connections, skills and memory |
| Skills | `.agents/skills/<name>/SKILL.md` (own and shared) |
| Context | `context/brand/` (read-only copy), `drafts/` for draft agents |

Codex and Grok read `AGENTS.md` and `.agents/skills` natively. Claude Code
reads `AGENTS.md` natively and loads `.agents/` with `--plugin-dir` (its skills
show up as `.agents:<name>`). Antigravity reads both natively. MCP servers
stay per engine: a `--mcp-config` file in the run folder (Claude Code),
`-c mcp_servers.*` (Codex), `.grok/config.toml` in the session folder (Grok,
loaded with `--trust`), and `.agents/mcp_config.json` in the session folder
(Antigravity).

**Headless runs**: `claude -p --input-format stream-json --output-format
stream-json --replay-user-messages --verbose` with `--session-id`/`--resume`,
`--permission-mode dontAsk`, a limited `--tools` set, `--strict-mcp-config`;
and `codex app-server` (JSON-RPC on stdio: `thread/start` or `thread/resume`,
then `turn/start`) with `sandbox_mode` read-only or workspace-write and
`approval_policy=never`; and `grok --prompt-file <f> --output-format
streaming-json` with `-s`/`-r`, `--permission-mode dontAsk` and a limited
`--tools` set. Prompts go in on stdin (Claude Code, Codex) or a file (Grok).
The Codex app server is marked experimental in the CLI, so a Codex update can
break that adapter.

**Messages while an agent works**: on Claude Code and Codex an owner message
goes into the running turn (steering) and the agent reads it at its next step:
Claude Code takes it as another stream-json user message, Codex as
`turn/steer`. Both report when the agent has read it, and until then the
message shows "Sent · reads this at the next step". A message that misses the
turn (it ended first) becomes the next turn. On Grok and Antigravity, a
message waits for the turn to end and shows "Queued" until then. Messages
also queue when others are already waiting, and for a specialist's answer to
its own question, so the reply reaches whoever asked it for work. Grok
(`grok agent stdio`, `x.ai/interject`) and Antigravity (`agy acp`, a second
`session/prompt`) can steer too, through ACP; not wired up yet. A message that waits shows as a
chip above the composer, where it can be edited or removed until the agent
has it. `CREW_STEERING=off` turns steering off: every message then waits.

**One MCP server for every agent**: each CLI starts the `crew` MCP server
(`apps/conductor/src/mcp-bridge.ts`, stdio). It offers the lead's subagent
tools, `rename_thread` (lead), `ask_owner`, `show_preview`,
`save_artifact` (specialists), `read_artifact`, the memory tools and the
agent's own `tools/`. A subagent tool starts or reuses that specialist's
session in the same thread, on its engine and model, waits and returns the
answer. Turns time out per the lead's `limits` in `agent/agent.ts`.

**Thread titles**: a new thread first shows its opening line. In the
background a small model on the lead's engine (Haiku on Claude Code,
GPT-6-Luna on Codex; otherwise, or when that model is unavailable, the
lead's own model) writes a 3–6 word title and replaces it. The
lead can rename the thread later with `rename_thread` when the work turns
out to be about something else.

**Recovery**: threads, sessions, turns and events are stored in
`~/.crew/crew.db`. On start, the conductor marks running turns as interrupted,
closes their subagent cards, stops any CLI left over from a crash (only if its
command line still names that Crew session), and puts the thread in the Inbox.
Resume uses the CLI's own session resume. Owner messages that were still
queued when Crew stopped are kept and handed to the agent on Resume. Stop and
Close thread also drop queued turns, and say so in the thread.

**Safety**: read and draft only.
- Claude Code and Grok run with `dontAsk`, no shell, and only the tools an agent
  needs; draft roles may write only in `drafts/`. Codex runs in its read-only
  or workspace-write sandbox. Antigravity runs with per-run settings (`--settings`, never
  saved): anything not allowed is soft-denied in headless mode, and the allow
  rules are reading the session folder, `mcp(crew/*)`, the connection's
  allow-listed tools and, for draft agents, writing in `drafts/`; shell
  commands, Crew's deny paths and (without web access) URLs are denied.
- One deny list (`denyPaths()` in `apps/conductor/src/config.ts`) keeps Claude
  Code and Grok agents out of this repo (the team folder, `.env.local`), Crew's
  engine folders, `conductor.json` (the app token), `crew.db`, `~/.ssh`,
  `~/.claude`, `~/.codex`, `~/.grok`, `~/.cursor`, `~/.agents`, `~/.config` and
  `~/Library`. Codex's sandbox blocks writes and network, but **not reads**: a
  Codex agent could still `cat` a file elsewhere on disk. Containers per session
  are out of scope.
- Agents inherit only basic environment variables (PATH, HOME, locale, proxy
  settings); nothing from `.env.local`. Codex shells get only the core set.
- Roles with a store connection (the store manager) get no web search or web
  fetch, so store and customer data cannot be sent out.
- The browser (`@crew/kit/browser`, agent-browser) goes only to agents without
  store or customer data. Its allow-list leaves out JavaScript eval, saved
  logins and profiles, uploads and network tools; `guard.ts` hides those from
  the agent and refuses them. Screenshots come back inline, and are saved
  only with `keep: true`, under a name the guard picks; page text
  comes back in boundary markers and capped in size. agent-browser's own
  action policy is not relied on: it did not block eval when tested (v0.43.0).
- Grok agents with web access can also search X (`x_search`). The web
  researcher's `x_search` tool runs Grok once per question with only that
  tool allowed; Grok sees the question and nothing else.
- Shopify reads: the MCP server parses every query with GraphQL's own parser
  and refuses anything that is not a pure query, and the Shopify CLI itself
  refuses mutations without `--allow-mutations` (not passed there).
- Shopify changes: only the store manager's `shopify_mutate` tool passes
  `--allow-mutations`, and every call waits in the Inbox for the owner's
  approval first. The stored authentication has write access to products,
  collections and inventory only (`write_products`, `write_inventory`). External connection
  tools on Codex run only when marked read-only.
- The local API binds to 127.0.0.1 and needs the token from `conductor.json`
  as a header (the WebSocket takes it as `?token=`). The Electron window only
  ever loads the app itself, and only that page can ask for the token.
- Known gap: Grok has no way to pass an MCP server's env by name, so the
  per-session bridge token sits in that session's own `.grok/config.toml`. It
  works for that session only.

## Testing the assumptions

| Assumption | How to check |
| --- | --- |
| Cross-engine call returns to the same chat | `pnpm crew eval handoff`: GM calls the Store manager, which hands back an artifact (the cross-engine case needs a specialist on another engine again) |
| One agent folder → every engine | `pnpm crew translate <agent> claude-code` and `… codex`, or `pnpm crew try` with both engines |
| Routing, memory and hand-back | `pnpm crew eval` (add the five real tasks as evals) |
| Three parallel chats + resume after restart | Start three threads, stop the conductor (Ctrl-C or kill), start it again, hit Resume in the Inbox |
| App experience | `pnpm dev`: sidebar, thread with subagent cards and Step in, preview panel, Inbox, Agents (design system: `packages/ui`, see its README) |
| Model per agent | `pnpm crew try <agent> "<prompt>" --models …` |
| Real tasks | Run the five tasks, then `pnpm crew verdict` per thread and `pnpm crew report` |

## Troubleshooting

- **"Electron failed to install correctly"**: Electron's installer sometimes
  fails to unpack under Node 26. Unzip the cached download by hand:
  `cd node_modules/.pnpm/electron@*/node_modules/electron && mkdir -p dist && unzip -q ~/Library/Caches/electron/*/electron-v*-darwin-arm64.zip -d dist && printf 'Electron.app/Contents/MacOS/Electron' > path.txt`
- **The app opens as plain Node**: some terminals set `ELECTRON_RUN_AS_NODE=1`.
  `pnpm app` clears it.
- **Dev only**: `CREW_SHARED_ENGINE_HOME=1` reuses your personal Claude Code,
  Codex and Grok sign-in instead of Crew's own folders. Agents may then see your
  personal skills and settings. Don't use it for real work.
- `CREW_HOME` moves all Crew data (default `~/.crew`).

## Still needed from the owner

- Shopify CLI authentication with the read and write scopes in Setup (run it
  again if you authenticated before the store manager could make changes).
- `pnpm crew login claude`, `pnpm crew login codex`, `pnpm crew login grok`
  (a SuperGrok or X subscription, or `XAI_API_KEY`) and `pnpm crew login antigravity`
  (Google AI Pro/Ultra or Gemini Enterprise).
- The five real tasks for milestone 6.
