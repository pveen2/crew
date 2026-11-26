// Code work for agents with permissions 'code' (a Developer).
//
// Each session of such an agent gets its own clone of the team's code repo in
// <workdir>/repo, on its own branch (crew/<thread>-<session>). The agent edits files and
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
// The agent can never merge: only the owner can, with the Merge button in the Inbox
// (mergePullRequest). Protect the base branch on GitHub to require reviews or checks.

import { execFile } from 'node:child_process';
import { createHash, createSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
//
// The agent can write anything in repo/, including repo/.git (hooks, config,
// filters) and files the Shopify CLI reads (shopify.theme.toml). Nothing that
// runs here with credentials may trust that. So the conductor keeps its own git
// directory per session in paths.run (out of the agent's reach), with its own
// config, HEAD and branch, and reads the agent's files only as a work tree:
// no hooks, no fsmonitor, no system or global config. Previews and reviews run
// on a snapshot of the committed tree without symlinks or tool config.

/** Environment for git and the Shopify CLI: nothing from the conductor's own (.env.local). */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return { ...env, ...extra };
}

const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=false'];

/** Runs git with the token as an HTTP header from the environment: never in a URL, a config file or argv. */
async function git(cwd: string, args: string[], opts: { token?: string; signal?: AbortSignal } = {}): Promise<string> {
  const env = cleanEnv({
    HOME: paths.repos,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });
  if (opts.token) {
    const basic = Buffer.from(`x-access-token:${opts.token}`).toString('base64');
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  }
  try {
    const { stdout } = await run('git', [...SAFE_GIT, ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024, signal: opts.signal });
    return stdout;
  } catch (err) {
    const e = err as Error & { stderr?: string };
    if (opts.signal?.aborted) throw new Error('Stopped.');
    throw new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('/')) ?? ''} failed: ${(e.stderr ?? e.message).trim().slice(0, 800)}`);
  }
}

const mirrorLocks = new Map<string, Promise<unknown>>();

/** One bare copy of the repo per conductor, fetched before each new checkout. */
async function updateMirror(s: CodeSettings): Promise<string> {
  const dir = join(paths.repos, s.owner, `${s.name}.git`);
  const prev = mirrorLocks.get(dir) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const token = await githubToken(s);
    if (!existsSync(dir)) {
      mkdirSync(join(paths.repos, s.owner), { recursive: true, mode: 0o700 });
      await git(paths.repos, ['clone', '--bare', repoUrl(s), dir], { token });
    }
    await git(dir, ['fetch', '--prune', repoUrl(s), `+refs/heads/${s.base}:refs/heads/${s.base}`], { token });
  });
  mirrorLocks.set(dir, next);
  await next;
  return dir;
}

const repoUrl = (s: CodeSettings) => `https://github.com/${s.repo}.git`;

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** The conductor's own git directory for a session, outside the agent's folder. */
const conductorGitDir = (sessionId: string) => join(paths.run, sessionId, 'code.git');

interface Checkout {
  repo: string;
  gitDir: string;
}

/** git on the conductor's git directory, with the agent's repo/ as the work tree. */
function cg(c: Checkout, args: string[], opts: { token?: string; signal?: AbortSignal } = {}): Promise<string> {
  return git(c.gitDir, ['--git-dir', c.gitDir, '--work-tree', c.repo, ...args], opts);
}

/**
 * The session's own checkout in <workdir>/repo, from the latest base branch, and
 * the conductor's git directory that tracks it on a branch for this session.
 * Made once per session; later turns keep both.
 */
export async function ensureCheckout(s: CodeSettings, workdir: string, sessionId: string, threadTitle: string): Promise<string> {
  const repo = join(workdir, 'repo');
  const gitDir = conductorGitDir(sessionId);
  if (existsSync(join(gitDir, 'HEAD')) && existsSync(repo)) return repo;
  const mirror = await updateMirror(s);
  mkdirSync(workdir, { recursive: true });
  rmSync(gitDir, { recursive: true, force: true });
  const branch = `${s.branchPrefix}${slug(threadTitle) || 'work'}-${sessionId.slice(2).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  if (!existsSync(join(repo, '.git'))) {
    // The agent's own clone, for its own git status/diff/log. --shared: objects come from the mirror.
    await git(workdir, ['clone', '-q', '--shared', '--branch', s.base, mirror, 'repo']);
    await git(repo, ['checkout', '-q', '-b', branch]);
    await git(repo, ['remote', 'set-url', 'origin', repoUrl(s)]);
  }
  // The conductor's: bare, then used with repo/ as its work tree.
  mkdirSync(join(paths.run, sessionId), { recursive: true, mode: 0o700 });
  await git(paths.run, ['clone', '-q', '--bare', '--shared', mirror, gitDir]);
  await git(gitDir, ['config', 'core.bare', 'false']);
  await git(gitDir, ['branch', branch, s.base]);
  await git(gitDir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  const who = await commitIdentity();
  await git(gitDir, ['config', 'user.name', who.name]);
  await git(gitDir, ['config', 'user.email', who.email]);
  await cg({ repo, gitDir }, ['reset', '-q']);
  return repo;
}

function checkoutOf(workdir: string, sessionId: string): Checkout {
  const c = { repo: join(workdir, 'repo'), gitDir: conductorGitDir(sessionId) };
  if (!existsSync(c.repo) || !existsSync(join(c.gitDir, 'HEAD'))) {
    throw new Error('There is no checkout yet: it is made at the start of your turn. Try again next turn.');
  }
  return c;
}

async function branchOf(c: Checkout, s: CodeSettings): Promise<string> {
  const ref = (await git(c.gitDir, ['symbolic-ref', 'HEAD'])).trim();
  const branch = ref.replace(/^refs\/heads\//, '');
  if (!branch.startsWith(s.branchPrefix) || branch === s.base) throw new Error(`Refusing to work on ${branch}.`);
  return branch;
}

/** Stages everything in repo/ and returns the change against the base branch, untracked files included. */
export async function branchDiff(s: CodeSettings, workdir: string, sessionId: string, signal?: AbortSignal): Promise<{ stat: string; diff: string }> {
  const c = checkoutOf(workdir, sessionId);
  await cg(c, ['add', '-A'], { signal });
  const mergeBase = (await cg(c, ['merge-base', 'HEAD', s.base], { signal })).trim();
  const stat = (await cg(c, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat', mergeBase], { signal })).trim();
  const diff = await cg(c, ['diff', '--cached', '--no-ext-diff', '--no-textconv', mergeBase], { signal });
  return { stat, diff };
}

/** Files that make tools run code or change where they write. Left out of every snapshot. */
const UNSAFE_NAMES = new Set(['.claude', '.codex', '.gemini', '.grok', '.cursor', '.mcp.json', 'shopify.theme.toml', '.shopify']);

function scrub(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink() || UNSAFE_NAMES.has(entry.name)) rmSync(p, { recursive: true, force: true });
    else if (entry.isDirectory()) scrub(p);
  }
}

/**
 * Writes the staged tree (all of it, or one folder) into a fresh folder under
 * paths.run, without symlinks or tool config. Returns the folder; the caller removes it.
 */
export async function snapshot(workdir: string, sessionId: string, only?: string, signal?: AbortSignal): Promise<string> {
  const c = checkoutOf(workdir, sessionId);
  await cg(c, ['add', '-A'], { signal });
  const dir = join(paths.run, sessionId, `snapshot-${Date.now()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A tree read from the index into a temporary index, checked out with the snapshot as the work tree.
  const tree = (await cg(c, ['write-tree'], { signal })).trim();
  const index = join(dir, '..', `snapshot-index-${Date.now()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    const withIndex = (args: string[]) =>
      run('git', [...SAFE_GIT, '--git-dir', c.gitDir, '--work-tree', dir, ...args], {
        cwd: dir,
        env: cleanEnv({ HOME: paths.repos, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env }),
        maxBuffer: 64 * 1024 * 1024,
        signal,
      });
    await withIndex(['read-tree', only ? `${tree}:${only}` : tree]);
    await withIndex(['checkout-index', '-a', '-f']);
  } finally {
    rmSync(index, { force: true });
  }
  scrub(dir);
  return dir;
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
 * Pushes the theme in repo/ to the store's development theme: one per
 * conductor, never the live theme or a shared unpublished one. One push at a
 * time; the last push wins, so a preview link shows whichever branch went last.
 * It pushes a snapshot, so the repo's shopify.theme.toml cannot change the target.
 * Auth: SHOPIFY_CLI_THEME_TOKEN (a Theme Access password) when set, else the CLI's own sign-in.
 */
export async function themePreview(s: CodeSettings, workdir: string, sessionId: string, store: string | undefined, signal?: AbortSignal): Promise<PreviewResult> {
  if (!s.themePath) throw new Error('This team has no theme: set code.theme.path in crew.config.ts.');
  if (!store) throw new Error('This team has no store: set shopify.store in crew.config.ts.');
  const c = checkoutOf(workdir, sessionId);
  const branch = await branchOf(c, s);

  const job = previewLock.catch(() => {}).then(async () => {
    if (signal?.aborted) throw new Error('Stopped.');
    const dir = await snapshot(workdir, sessionId, s.themePath, signal);
    const env = cleanEnv({ HOME: REAL_HOME, SHOPIFY_CLI_NO_ANALYTICS: '1' });
    if (process.env.SHOPIFY_CLI_THEME_TOKEN) env.SHOPIFY_CLI_THEME_TOKEN = process.env.SHOPIFY_CLI_THEME_TOKEN;
    try {
      const { stdout } = await run(
        'shopify',
        ['theme', 'push', '--development', '--path', dir, '--store', store, '--json', '--no-color'],
        { cwd: dir, env, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, signal },
      );
      type ThemeJson = { id?: number; preview_url?: string; previewUrl?: string; editor_url?: string; editorUrl?: string };
      const json = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { theme?: ThemeJson };
      const t = json.theme;
      // Shopify CLI 3 writes snake_case, CLI 5 camelCase.
      const previewUrl = t?.previewUrl ?? t?.preview_url;
      if (!previewUrl) throw new Error(`Unexpected output from shopify theme push: ${stdout.slice(0, 400)}`);
      return { previewUrl, editorUrl: t?.editorUrl ?? t?.editor_url ?? '', themeId: String(t?.id ?? ''), branch };
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string; code?: string };
      if (signal?.aborted) throw new Error('Stopped.');
      if (e.code === 'ENOENT') throw new Error('The Shopify CLI is not installed where the conductor runs.');
      const detail = `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim() || e.message;
      if (/auth|log ?in|password|401|403/i.test(detail)) {
        throw new Error(`Shopify refused the theme push. Ask the owner to set SHOPIFY_CLI_THEME_TOKEN (a Theme Access password) for the conductor. ${detail.slice(0, 400)}`);
      }
      throw new Error(`shopify theme push failed: ${detail.slice(0, 1200)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

/** Commits what changed in repo/, pushes this session's branch and opens a pull request, or updates the open one. */
export async function openPullRequest(
  s: CodeSettings,
  workdir: string,
  sessionId: string,
  input: { title: string; body: string; commitMessage?: string },
  signal?: AbortSignal,
): Promise<PullRequestResult> {
  const c = checkoutOf(workdir, sessionId);
  const { stat } = await branchDiff(s, workdir, sessionId, signal);
  if (!stat) throw new Error(`There are no changes against ${s.base}: nothing to open a pull request for.`);
  const pending = (await cg(c, ['diff', '--cached', '--name-only'], { signal })).trim();
  if (pending) await cg(c, ['commit', '-q', '--no-verify', '-m', input.commitMessage?.trim() || input.title], { signal });
  const branch = await branchOf(c, s);
  const token = await githubToken(s);
  if (signal?.aborted) throw new Error('Stopped.');
  // A plain push to a fixed URL: the branch only ever grows from this session, so anything else is refused, not overwritten.
  await git(c.gitDir, ['push', '-q', repoUrl(s), `refs/heads/${branch}:refs/heads/${branch}`], { token, signal });

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

/** Identifies exactly which changes a review saw: open_pull_request only goes ahead when the current diff has the same hash. */
export function diffHash(diff: string): string {
  return createHash('sha256').update(diff).digest('hex');
}

export interface ReviewRound {
  model: string;
  hash: string;
  text: string;
  at: number;
}

/** Posts the reviewer's own words on the pull request, so the owner reads the review itself, not the developer's summary of it. */
export async function postReviews(s: CodeSettings, number: number, rounds: ReviewRound[], total: number): Promise<void> {
  if (!rounds.length) return;
  const latest = rounds[rounds.length - 1]!;
  const earlier = rounds.slice(0, -1);
  const first = total - rounds.length + 1;
  const quote = (t: string) => t.trim().slice(0, 20_000);
  const parts = [
    `## Code review by ${latest.model} (round ${total})`,
    `Reviewed the exact changes in this pull request (diff \`${latest.hash.slice(0, 12)}\`).`,
    '',
    quote(latest.text),
    ...earlier.map((r, i) =>
      ['', `<details><summary>Round ${first + i} by ${r.model} (earlier version of the changes)</summary>`, '', quote(r.text), '', '</details>'].join('\n'),
    ),
    '',
    '---',
    'Posted by Crew from the `code_review` tool, unedited.',
  ];
  const auth = `Bearer ${await githubToken(s)}`;
  await api('POST', `/repos/${s.owner}/${s.name}/issues/${number}/comments`, auth, { body: parts.join('\n') });
}

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

// ---------------------------------------------------------------------------
// Merge, by the owner from the Inbox (never by an agent)

/** Merges an open pull request on the code repo, with a method the repo allows. GitHub's own rules (required reviews, checks) still apply. */
export async function mergePullRequest(s: CodeSettings, url: string): Promise<{ sha: string; method: string }> {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m || `${m[1]}/${m[2]}`.toLowerCase() !== s.repo.toLowerCase()) throw new Error(`${url} is not a pull request on ${s.repo}.`);
  const auth = `Bearer ${await githubToken(s)}`;
  const base = `/repos/${s.owner}/${s.name}`;
  const pr = await api<{ state: string; merged: boolean; mergeable: boolean | null; head: { sha: string }; title: string }>('GET', `${base}/pulls/${m[3]}`, auth);
  if (pr.merged) throw new Error(`Pull request #${m[3]} is already merged.`);
  if (pr.state !== 'open') throw new Error(`Pull request #${m[3]} is closed.`);
  if (pr.mergeable === false) throw new Error(`Pull request #${m[3]} has conflicts with ${s.base}: ask the developer to update the branch.`);
  const repo = await api<{ allow_merge_commit?: boolean; allow_squash_merge?: boolean; allow_rebase_merge?: boolean }>('GET', base, auth);
  const method = repo.allow_squash_merge !== false ? 'squash' : repo.allow_merge_commit !== false ? 'merge' : repo.allow_rebase_merge !== false ? 'rebase' : 'merge';
  // sha: refuse if the branch moved after the owner looked at it.
  const res = await api<{ sha: string }>('PUT', `${base}/pulls/${m[3]}/merge`, auth, {
    merge_method: method,
    sha: pr.head.sha,
    ...(method === 'squash' ? { commit_title: `${pr.title} (#${m[3]})` } : {}),
  });
  return { sha: res.sha, method };
}
