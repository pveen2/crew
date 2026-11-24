import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '@crew/protocol';
import { TEAM_ROOT } from '@crew/sdk/load';

export const CONDUCTOR_SRC = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(CONDUCTOR_SRC, '../../..');

export const CREW_HOME = process.env.CREW_HOME ?? join(homedir(), '.crew');

/**
 * Engine sign-ins live here. CREW_ENGINES_DIR lets a second conductor with its own
 * CREW_HOME (an eval run, a dev build) reuse the owner's sign-ins: Claude Code keys its
 * keychain entry by this exact path, so a symlink is not enough.
 */
const ENGINES = process.env.CREW_ENGINES_DIR?.trim() || join(CREW_HOME, 'engines');

export const paths = {
  home: CREW_HOME,
  db: join(CREW_HOME, 'crew.db'),
  info: join(CREW_HOME, 'conductor.json'),
  /** One working folder per session. The agent only works in here. */
  sessions: join(CREW_HOME, 'sessions'),
  /** Conductor-owned files per session (MCP config, settings). Agents do not get these as context. */
  run: join(CREW_HOME, 'run'),
  try: join(CREW_HOME, 'try'),
  /** Images the owner attached, per thread. Agents get copies in their own attachments/ folder. */
  attachments: join(CREW_HOME, 'attachments'),
  /** Separate engine configuration folders, signed in once with `pnpm crew login`. */
  engines: {
    claude: join(ENGINES, 'claude'),
    codex: join(ENGINES, 'codex'),
    /** Codex reads ~/.agents/skills whatever CODEX_HOME says; its Crew sessions get their own HOME. */
    codexHome: join(ENGINES, 'codex', 'home'),
    grok: join(ENGINES, 'grok'),
    /** Grok also reads ~/.claude, ~/.cursor and ~/.agents; its Crew sessions get their own HOME. */
    grokHome: join(ENGINES, 'grok', 'home'),
    /** HOME for Antigravity (agy keeps settings in ~/.gemini; its sign-in is in the OS keyring). */
    antigravityHome: join(ENGINES, 'antigravity', 'home'),
  },
  bridge: join(CONDUCTOR_SRC, 'mcp-bridge.ts'),
};

/**
 * Env for a child that runs a script with process.execPath. In the installed
 * Mac app that is the Crew binary (Electron), which runs scripts as Node only
 * with ELECTRON_RUN_AS_NODE; elsewhere it is plain Node and needs nothing.
 */
export const nodeChildEnv: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};

export const port = Number(process.env.CREW_PORT ?? DEFAULT_PORT);

/**
 * DEV ONLY. Use the owner's personal ~/.claude and ~/.codex sign-in instead of
 * Crew's own engine folders. Agents may then see personal skills and settings.
 */
export const sharedEngineHome = process.env.CREW_SHARED_ENGINE_HOME === '1';
/** CREW_STEERING=off: never write owner messages into a running turn; they always wait for it to end. */
export const steeringEnabled = process.env.CREW_STEERING !== 'off';

export function ensureDirs(): void {
  for (const dir of [
    paths.home,
    paths.sessions,
    paths.run,
    paths.try,
    paths.attachments,
    paths.engines.claude,
    paths.engines.codex,
    paths.engines.codexHome,
    paths.engines.grok,
    paths.engines.grokHome,
    paths.engines.antigravityHome,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeGrokConfig();
  linkKeychains();
}

/**
 * Antigravity keeps its sign-in in the macOS keychain, and macOS finds the
 * login keychain under $HOME/Library/Keychains. Crew runs agy with its own
 * HOME, so without this link every sign-in ends in "A keychain cannot be
 * found to store antigravity". Only the keychain folder is shared; the rest
 * of the real home stays out.
 */
function linkKeychains(): void {
  if (process.platform !== 'darwin') return;
  const real = join(userInfo().homedir, 'Library', 'Keychains');
  const link = join(paths.engines.antigravityHome, 'Library', 'Keychains');
  try {
    lstatSync(link);
    return;
  } catch {}
  if (!existsSync(real)) return;
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  symlinkSync(real, link);
}

/**
 * Crew's own Grok config. Grok reads Claude Code and Cursor setup for
 * compatibility; switch all of that off, and give it a [permission] section so
 * it never falls back to ~/.claude/settings*.json.
 */
function writeGrokConfig(): void {
  const lines = ['# Written by Crew on every start. Do not edit.'];
  for (const vendor of ['claude', 'cursor']) {
    lines.push('', `[compat.${vendor}]`);
    for (const cell of ['skills', 'rules', 'agents', 'mcps', 'hooks', 'sessions']) lines.push(`${cell} = false`);
  }
  lines.push('', '[compat.codex]', 'sessions = false', '', '[permission]', 'allow = []', 'deny = []', '');
  writeFileSync(join(paths.engines.grok, 'config.toml'), lines.join('\n'), { mode: 0o600 });
}

/**
 * Environment variables an agent process may inherit. Everything else in the
 * conductor's environment (including .env.local) stays out.
 */
export const AGENT_ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TERM_PROGRAM|COLORTERM|TMPDIR|TZ|LANG|LC_[A-Z]+|__CF_USER_TEXT_ENCODING|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy)$/;

/** The owner's real home folder, for MCP servers that need it (the Shopify CLI keeps its login there). */
export const REAL_HOME = homedir();

/**
 * Files and folders no agent may read or write. Claude Code and Grok enforce
 * these as permission rules; Codex's sandbox blocks writes and network, not reads.
 */
export function denyPaths(): string[] {
  const h = REAL_HOME;
  return [
    REPO_ROOT,
    // The team definition (instructions, tools, evals) may sit in another repo.
    TEAM_ROOT,
    paths.engines.claude,
    paths.engines.codex,
    paths.engines.grok,
    dirname(paths.engines.antigravityHome),
    paths.run,
    paths.attachments,
    paths.info,
    join(paths.home, 'app.json'),
    paths.db,
    `${paths.db}-wal`,
    `${paths.db}-shm`,
    join(h, '.ssh'),
    join(h, '.claude'),
    join(h, '.claude.json'),
    join(h, '.codex'),
    join(h, '.grok'),
    join(h, '.gemini'),
    join(h, '.cursor'),
    join(h, '.agents'),
    join(h, '.config'),
    join(h, 'Library'),
  ];
}
