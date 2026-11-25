// Code work for agents with permissions 'code' (a Developer).
//
// Each session of such an agent gets its own clone of the team's code repo in
// <workdir>/repo, on its own branch (crew/<thread>). The agent edits files and
// runs a sandboxed shell there, with no credentials and no network. Everything
// that needs a credential runs here, in the conductor, through Crew's own tools:
//
//   theme_preview       push the working tree to the store's development theme, return the links
//   open_pull_request   commit, push the branch and open (or update) a pull request
//   code_review         a second model, from another vendor, reviews the branch's changes
//
// GitHub access is a GitHub App (CREW_GITHUB_APP_ID + CREW_GITHUB_APP_PRIVATE_KEY or
// CREW_GITHUB_APP_PRIVATE_KEY_FILE), installed on the repo with Contents and Pull
// requests read/write. Its tokens last an hour and cover only the installation's
// repos. Without an App (a developer's own Mac) Crew falls back to `gh auth token`.
// The agent can never merge: protect the base branch on GitHub.

import { execFile } from 'node:child_process';
import { createSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CodeConfig } from '@crew/sdk/define';
import { REAL_HOME, paths } from './config.ts';

const run = promisify(execFile);
const GITHUB = 'https://api.github.com';

export interface CodeSettings {
  repo: string;
  owner: string;
  name: string;
  base: string;
  branchPrefix: string;
  themePath?: string;
  reviewer: string;
}

export function codeSettings(config: CodeConfig | undefined): CodeSettings {
  if (!config?.repo) throw new Error("This team has no code repo: set code.repo in crew.config.ts.");
  const [owner, name] = config.repo.split('/') as [string, string];
  return {
    repo: config.repo,
    owner,
    name,
    base: config.base ?? 'main',
    branchPrefix: config.branchPrefix ?? 'crew/',
    themePath: config.theme?.path,
    reviewer: config.reviewer ?? 'codex/gpt-6.2-sol@high',
  };
}

// ---------------------------------------------------------------------------
// GitHub credentials

interface Token {
  value: string;
  expiresAt: number;
}

/** One per conductor: a team has one code repo. */
let cachedToken: Token | null = null;
let cachedIdentity: { name: string; email: string } | null = null;

function appKey(): { id: string; key: string } | null {
  const id = process.env.CREW_GITHUB_APP_ID?.trim();
  const file = process.env.CREW_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  const key = process.env.CREW_GITHUB_APP_PRIVATE_KEY?.trim().replace(/\\n/g, '\n') || (file ? readFileSync(file, 'utf8') : '');
  return id && key ? { id, key } : null;
}

function appJwt(app: { id: string; key: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 9 * 60, iss: app.id })}`;
  const signature = createSign('RSA-SHA256').update(body).sign(app.key).toString('base64url');
  return `${body}.${signature}`;
}

async function api<T>(method: string, path: string, auth: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GITHUB}${path}`, {
    method,
    headers: {
      authorization: auth,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'crew-conductor',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** A token that can push to and open pull requests on the repo. */
export async function githubToken(s: CodeSettings): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60_000) return cachedToken.value;
  const app = appKey();
  if (!app) {
    try {
      const { stdout } = await run('gh', ['auth', 'token'], { env: { ...process.env, HOME: REAL_HOME } });
      const value = stdout.trim();
      if (value) {
        cachedToken = { value, expiresAt: Date.now() + 30 * 60_000 };
        return value;
      }
    } catch {
      // Fall through to the error below.
    }
    throw new Error(
      'GitHub is not set up for Crew: set CREW_GITHUB_APP_ID and CREW_GITHUB_APP_PRIVATE_KEY_FILE in the conductor environment ' +
        '(a GitHub App installed on the repo with Contents and Pull requests read/write), or sign in with `gh auth login` on this machine.',
    );
  }
  const jwt = `Bearer ${appJwt(app)}`;
  const installation = await api<{ id: number }>('GET', `/repos/${s.owner}/${s.name}/installation`, jwt).catch((err) => {
    throw new Error(`The Crew GitHub App is not installed on ${s.repo}. Install it there first. (${(err as Error).message})`);
  });
  const token = await api<{ token: string; expires_at: string }>('POST', `/app/installations/${installation.id}/access_tokens`, jwt, {
    repositories: [s.name],
    permissions: { contents: 'write', pull_requests: 'write' },
  });
  cachedToken = { value: token.token, expiresAt: Date.parse(token.expires_at) };
  return token.token;
}

/** Who the commits are by: the App's bot user, so the owner sees they came from Crew. */
async function commitIdentity(): Promise<{ name: string; email: string }> {
  if (cachedIdentity) return cachedIdentity;
  const app = appKey();
  let identity = { name: 'Crew', email: 'crew@users.noreply.github.com' };
  if (app) {
    try {
      const jwt = `Bearer ${appJwt(app)}`;
      const me = await api<{ slug: string }>('GET', '/app', jwt);
      const login = `${me.slug}[bot]`;
      const user = await api<{ id: number }>('GET', `/users/${encodeURIComponent(login)}`, jwt);
      identity = { name: login, email: `${user.id}+${login}@users.noreply.github.com` };
    } catch {
      // Keep the plain identity.
    }
  }
  cachedIdentity = identity;
  return identity;
}

// ---------------------------------------------------------------------------
// git

/** Runs git with the token as an HTTP header from the environment: never in a URL, a config file or argv. */
async function git(cwd: string, args: string[], token?: string): Promise<string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  }
  try {
    const { stdout } = await run('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as Error & { stderr?: string };
    throw new Error(`git ${args[0]} failed: ${(e.stderr ?? e.message).trim().slice(0, 800)}`);
  }
}

const mirrorLocks = new Map<string, Promise<unknown>>();

/** One bare copy of the repo per conductor, fetched before each new checkout. */
async function updateMirror(s: CodeSettings): Promise<string> {
  const dir = join(paths.repos, s.owner, `${s.name}.git`);
  const prev = mirrorLocks.get(dir) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const token = await githubToken(s);
    const url = `https://github.com/${s.repo}.git`;
    if (!existsSync(dir)) {
      mkdirSync(join(paths.repos, s.owner), { recursive: true, mode: 0o700 });
      await git(paths.repos, ['clone', '--bare', url, dir], token);
    }
    await git(dir, ['fetch', '--prune', 'origin', `+refs/heads/${s.base}:refs/heads/${s.base}`], token);
  });
  mirrorLocks.set(dir, next);
  await next;
  return dir;
}

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * The session's own checkout in <workdir>/repo. Made once per session, from the
 * latest base branch, on a new branch named after the thread. Later turns keep it.
 */
export async function ensureCheckout(s: CodeSettings, workdir: string, threadId: string, threadTitle: string): Promise<string> {
  const repo = join(workdir, 'repo');
  if (existsSync(join(repo, '.git'))) return repo;
  const mirror = await updateMirror(s);
  mkdirSync(workdir, { recursive: true });
  // --shared: objects come from the mirror; new commits are written in repo/.git only.
  await git(workdir, ['clone', '--shared', '--branch', s.base, mirror, 'repo']);
  const branch = `${s.branchPrefix}${slug(threadTitle) || 'work'}-${threadId.slice(2).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  await git(repo, ['checkout', '-b', branch]);
  await git(repo, ['remote', 'set-url', 'origin', `https://github.com/${s.repo}.git`]);
  const who = await commitIdentity();
  await git(repo, ['config', 'user.name', who.name]);
  await git(repo, ['config', 'user.email', who.email]);
  return repo;
}

function checkoutOf(workdir: string): string {
  const repo = join(workdir, 'repo');
  if (!existsSync(join(repo, '.git'))) throw new Error('There is no checkout yet: it is made at the start of your turn. Try again next turn.');
  return repo;
}

async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

/** Stages everything and returns the change against the base branch, untracked files included. */
export async function branchDiff(s: CodeSettings, workdir: string): Promise<{ repo: string; stat: string; diff: string }> {
  const repo = checkoutOf(workdir);
  await git(repo, ['add', '-A']);
  const mergeBase = (await git(repo, ['merge-base', 'HEAD', s.base])).trim();
  const stat = (await git(repo, ['diff', '--cached', '--stat', mergeBase])).trim();
  const diff = await git(repo, ['diff', '--cached', mergeBase]);
  return { repo, stat, diff };
}

// ---------------------------------------------------------------------------
// theme_preview

let previewLock: Promise<unknown> = Promise.resolve();

export interface PreviewResult {
  previewUrl: string;
  editorUrl: string;
  themeId: string;
  branch: string;
}

/**
 * Pushes the working tree's theme to the store's development theme: one per
 * conductor, never the live theme or a shared unpublished one. One push at a
 * time; the last push wins, so a preview link shows whichever branch went last.
 * Auth: SHOPIFY_CLI_THEME_TOKEN (a Theme Access password) when set, else the CLI's own sign-in.
 */
export async function themePreview(s: CodeSettings, workdir: string, store: string | undefined): Promise<PreviewResult> {
  if (!s.themePath) throw new Error('This team has no theme: set code.theme.path in crew.config.ts.');
  if (!store) throw new Error('This team has no store: set shopify.store in crew.config.ts.');
  const repo = checkoutOf(workdir);
  const themeDir = join(repo, s.themePath);
  if (!existsSync(themeDir)) throw new Error(`${s.themePath} is not in the checkout.`);
  const branch = await currentBranch(repo);

  const job = previewLock.catch(() => {}).then(async () => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: REAL_HOME, SHOPIFY_CLI_NO_ANALYTICS: '1' };
    try {
      const { stdout } = await run(
        'shopify',
        ['theme', 'push', '--development', '--path', themeDir, '--store', store, '--json', '--no-color'],
        { cwd: themeDir, env, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const json = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { theme?: { id?: number; preview_url?: string; editor_url?: string } };
      const t = json.theme;
      if (!t?.preview_url) throw new Error(`Unexpected output from shopify theme push: ${stdout.slice(0, 400)}`);
      return { previewUrl: t.preview_url, editorUrl: t.editor_url ?? '', themeId: String(t.id ?? ''), branch };
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string; code?: string };
      if (e.code === 'ENOENT') throw new Error('The Shopify CLI is not installed where the conductor runs.');
      const detail = `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim() || e.message;
      if (/auth|log ?in|password|401|403/i.test(detail)) {
        throw new Error(`Shopify refused the theme push. Ask the owner to set SHOPIFY_CLI_THEME_TOKEN (a Theme Access password) for the conductor. ${detail.slice(0, 400)}`);
      }
      throw new Error(`shopify theme push failed: ${detail.slice(0, 1200)}`);
    }
  });
  previewLock = job;
  return job;
}

// ---------------------------------------------------------------------------
// open_pull_request

export interface PullRequestResult {
  url: string;
  number: number;
  created: boolean;
  branch: string;
  stat: string;
}

/** Commits what is staged or changed, pushes the branch and opens a pull request, or updates the open one. */
export async function openPullRequest(
  s: CodeSettings,
  workdir: string,
  input: { title: string; body: string; commitMessage?: string },
): Promise<PullRequestResult> {
  const { repo, stat } = await branchDiff(s, workdir);
  if (!stat) throw new Error(`There are no changes against ${s.base}: nothing to open a pull request for.`);
  const pending = (await git(repo, ['status', '--porcelain'])).trim();
  if (pending) await git(repo, ['commit', '-q', '-m', input.commitMessage?.trim() || input.title]);
  const branch = await currentBranch(repo);
  if (branch === s.base) throw new Error(`Refusing to push to ${s.base}.`);
  const token = await githubToken(s);
  // A plain push: the branch only ever grows from this checkout, so anything else is refused, not overwritten.
  await git(repo, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], token);

  const auth = `Bearer ${token}`;
  const open = await api<Array<{ number: number; html_url: string }>>(
    'GET',
    `/repos/${s.owner}/${s.name}/pulls?state=open&head=${encodeURIComponent(`${s.owner}:${branch}`)}`,
    auth,
  );
  if (open[0]) {
    await api('PATCH', `/repos/${s.owner}/${s.name}/pulls/${open[0].number}`, auth, { title: input.title, body: input.body });
    return { url: open[0].html_url, number: open[0].number, created: false, branch, stat };
  }
  const pr = await api<{ number: number; html_url: string }>('POST', `/repos/${s.owner}/${s.name}/pulls`, auth, {
    title: input.title,
    body: input.body,
    head: branch,
    base: s.base,
  });
  return { url: pr.html_url, number: pr.number, created: true, branch, stat };
}

// ---------------------------------------------------------------------------
// code_review

export const REVIEW_PROMPT = (diff: string, stat: string, focus: string | undefined, rules: string) => `You review a change another agent made in this repository (your working folder). You are read-only: do not change files.

Find real problems only: bugs, broken behaviour, missing cases, security issues, and breaks of the repository's own rules (AGENTS.md files, docs). Read the surrounding code before you call something a bug. Skip style nits.

Answer in compact markdown, at most 500 words:
- **Verdict:** ready, or needs changes.
- **Problems:** each with file:line, what goes wrong and when, and the fix. Most serious first.
- **Checks:** what you could not verify.
${focus ? `\nThe developer asks you to look closely at: ${focus}\n` : ''}${rules ? `\nRepository rules to check against:\n\n${rules}\n` : ''}
## Files changed

${stat}

## Diff against the base branch

\`\`\`diff
${diff}
\`\`\`
`;
