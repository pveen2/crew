// The outside tools Crew depends on (engine CLIs, Shopify, the headless
// browser): whether each is installed and signed in, and a way for the app to
// start a sign-in. Sign-ins are interactive (browser pages, codes to paste,
// Antigravity's /quit), so they open in Terminal rather than running hidden.

import { execFile } from 'node:child_process';
import type { ConnectionId, ConnectionStatus } from '@crew/protocol';
import { loadCrew } from '@crew/sdk/load';
import { paths, sharedEngineHome } from './config.ts';
import { engines } from './engines/index.ts';

/** The team's store (crew.config.ts or SHOPIFY_STORE), read again before each check or sign-in. */
let shopifyStore = '';
async function refreshStore(): Promise<void> {
  shopifyStore = (await loadCrew().catch(() => undefined))?.config.shopify?.store ?? '';
}
const shopifyScopes = 'read_products,read_inventory,read_orders,read_customers,write_products,write_inventory';

interface Run {
  ok: boolean;
  out: string;
  /** The command is not installed. */
  missing: boolean;
  timedOut: boolean;
}

/**
 * PATH as a fresh login shell sees it. An install from the app adds its folder
 * to the shell profile, which the running conductor would otherwise never see.
 */
let loginPath: string | undefined;
async function refreshLoginPath(): Promise<void> {
  const r = await run(process.env.SHELL || '/bin/zsh', ['-lc', 'printf %s "$PATH"'], {}, 5_000, false);
  if (r.ok && r.out) loginPath = r.out.split('\n').at(-1);
}

function run(command: string, args: string[], env: Record<string, string> = {}, timeout = 15_000, usePath = true): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout, env: { ...process.env, ...(usePath && loginPath ? { PATH: loginPath } : {}), ...(sharedEngineHome ? {} : env) } },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          ok: !e,
          out: `${stdout ?? ''}${stderr ?? ''}`.trim(),
          missing: e?.code === 'ENOENT',
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });
}

type Check = Pick<ConnectionStatus, 'status' | 'detail'>;

function common(r: Run, label: string): Check | null {
  if (r.missing) return { status: 'missing', detail: `${label} is not installed` };
  if (r.timedOut) return { status: 'unknown', detail: 'The check timed out' };
  return null;
}

interface Def {
  id: ConnectionId;
  label: string;
  check: () => Promise<Check>;
  /** Shell command that installs the CLI, for when it is missing. */
  install?: string;
  /** Shell command that signs in. Undefined: nothing to sign in to. */
  signIn?: () => string;
}

function engineSignIn(engine: keyof typeof engines): () => string {
  return () => {
    const { command, args, env } = engines[engine].loginCommand();
    const vars = sharedEngineHome ? [] : Object.entries(env).map(([k, v]) => `${k}=${sh(v)}`);
    return [...(vars.length ? ['env', ...vars] : []), command, ...args.map(sh)].join(' ');
  };
}

const defs: Def[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    install: 'npm install -g @anthropic-ai/claude-code',
    signIn: engineSignIn('claude-code'),
    async check() {
      const r = await run('claude', ['auth', 'status'], { CLAUDE_CONFIG_DIR: paths.engines.claude });
      const c = common(r, 'Claude Code');
      if (c) return c;
      try {
        const j = JSON.parse(r.out) as { loggedIn?: boolean; email?: string };
        if (j.loggedIn) return { status: 'connected', detail: j.email };
      } catch {}
      return { status: 'signed_out' };
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    install: 'npm install -g @openai/codex',
    signIn: engineSignIn('codex'),
    async check() {
      const r = await run('codex', ['login', 'status'], { CODEX_HOME: paths.engines.codex });
      const c = common(r, 'Codex');
      if (c) return c;
      return r.ok && !/not logged in/i.test(r.out) ? { status: 'connected', detail: r.out.split('\n').at(-1) } : { status: 'signed_out' };
    },
  },
  {
    id: 'grok',
    label: 'Grok',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    signIn: engineSignIn('grok'),
    async check() {
      const r = await run('grok', ['models', ...(sharedEngineHome ? [] : ['--leader-socket', `${paths.engines.grok}/leader.sock`])], {
        GROK_HOME: paths.engines.grok,
        HOME: paths.engines.grokHome,
      });
      const c = common(r, 'Grok');
      if (c) return c;
      return r.ok && !/not authenticated|not (signed|logged) in|grok login/i.test(r.out) ? { status: 'connected' } : { status: 'signed_out' };
    },
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    signIn: () => `echo 'Sign in with Google in the browser. When it is ready, type /quit.' && ${engineSignIn('antigravity')()}`,
    async check() {
      const r = await run('agy', ['models'], { HOME: paths.engines.antigravityHome });
      const c = common(r, 'Antigravity');
      if (c) return c;
      if (!r.ok || /sign in/i.test(r.out)) return { status: 'signed_out' };
      const n = r.out.split('\n').filter((l) => /neon|gemini/i.test(l)).length;
      return { status: 'connected', detail: `${n} Gemini models` };
    },
  },
  {
    id: 'shopify',
    label: 'Shopify',
    install: 'npm install -g @shopify/cli@latest',
    signIn: () => `shopify store auth --store ${sh(shopifyStore)} --scopes ${sh(shopifyScopes)}`,
    async check() {
      if (!shopifyStore) return { status: 'unknown', detail: 'No store set in crew.config.ts' };
      const r = await run('shopify', ['store', 'execute', '--store', shopifyStore, '--json', '--query', '{ shop { name } }'], {}, 20_000);
      const c = common(r, 'The Shopify CLI');
      if (c) return c;
      if (r.ok) return { status: 'connected', detail: shopifyStore };
      if (/no stored app authentication|stored app authentication.*(?:expired|no longer valid)/i.test(r.out)) {
        return { status: 'signed_out', detail: shopifyStore };
      }
      return { status: 'unknown', detail: `Could not reach ${shopifyStore}` };
    },
  },
  {
    id: 'browser',
    label: 'Browser',
    install: 'npm install -g agent-browser && agent-browser install',
    async check() {
      const r = await run('agent-browser', ['--version']);
      return common(r, 'agent-browser') ?? (r.ok ? { status: 'connected', detail: r.out.split('\n')[0] } : { status: 'unknown', detail: r.out.slice(0, 200) });
    },
  },
];

/** Single-quote for a POSIX shell. */
function sh(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function usedBy(): Promise<Record<ConnectionId, string[]>> {
  const out: Record<ConnectionId, string[]> = { claude: [], codex: [], grok: [], antigravity: [], shopify: [], browser: [] };
  const crew = await loadCrew().catch(() => undefined);
  if (!crew) return out;
  const add = (id: ConnectionId, who: string) => {
    if (!out[id].includes(who)) out[id].push(who);
  };
  for (const a of Object.values(crew.agents)) {
    add(a.engine === 'claude-code' ? 'claude' : a.engine, a.label);
    if (a.tools.some((t) => t.name === 'x_search')) add('grok', a.label);
    for (const name of Object.keys(a.connections)) if (name === 'shopify' || name === 'browser') add(name, a.label);
  }
  return out;
}

let cache: ConnectionStatus[] | null = null;
let inflight: Promise<ConnectionStatus[]> | null = null;
const MAX_AGE_MS = 30_000;

export function connections(refresh = false): Promise<ConnectionStatus[]> {
  if (!refresh && cache && Date.now() - cache[0]!.checkedAt < MAX_AGE_MS) return Promise.resolve(cache);
  inflight ??= (async () => {
    try {
      await Promise.all([refreshLoginPath(), refreshStore()]);
      const [users, checks] = await Promise.all([usedBy(), Promise.all(defs.map((d) => d.check().catch((): Check => ({ status: 'unknown' }))))]);
      const now = Date.now();
      cache = defs.map((d, i) => {
        const c = checks[i]!;
        const canSignIn = c.status === 'missing' ? Boolean(d.install) : c.status !== 'connected' && Boolean(d.signIn);
        return { id: d.id, label: d.label, ...c, usedBy: users[d.id], canSignIn, checkedAt: now };
      });
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Open Terminal with the sign-in (and the install first, if the CLI is
 * missing). The command is built here from fixed pieces; the app only names
 * which connection.
 */
export async function signIn(id: string): Promise<void> {
  await refreshStore();
  const d = defs.find((x) => x.id === id);
  if (!d) throw new Error(`No such connection: ${id}`);
  const current = (await connections()).find((c) => c.id === id);
  const steps: string[] = [`echo ${sh(`Crew: ${current?.status === 'missing' ? 'installing' : 'signing in to'} ${d.label}`)}`];
  if (current?.status === 'missing') {
    if (!d.install) throw new Error(`${d.label} has no install step`);
    // A fresh login shell after the install, so a new PATH entry is picked up.
    steps.push(d.install, ...(d.signIn ? [`"$SHELL" -lc ${sh(d.signIn())}`] : []));
  } else {
    if (!d.signIn) throw new Error(`${d.label} has nothing to sign in to`);
    steps.push(d.signIn());
  }
  // pipefail: a failed download in `curl … | bash` must stop the chain.
  const script =
    `set -o pipefail; cd ~ && ${steps.join(' && ')} ` +
    `&& { echo; echo 'Done. You can close this window.'; } || { echo; echo 'That did not work. See the messages above.'; }`;

  if (process.platform !== 'darwin') throw new Error(`Run this in a terminal: ${script}`);
  const r = await run('osascript', [
    '-e', 'on run argv',
    '-e', 'tell application "Terminal"',
    '-e', 'activate',
    '-e', 'do script (item 1 of argv)',
    '-e', 'end tell',
    '-e', 'end run',
    script,
  ]);
  if (!r.ok) throw new Error(`Could not open Terminal: ${r.out}`);
  cache = null;
}
