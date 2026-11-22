// Where the installed app's team comes from, and its updates.
//
// settings.team in ~/.crew/app.json is one of:
//   undefined                                      the example team inside the app
//   { kind: 'github', repo: 'owner/name', path: 'crew', branch: 'main' }
//   { kind: 'folder', dir: '/path/to/team' }       a folder the owner manages
//
// A GitHub team runs from Crew's own clone in ~/.crew/teams/<owner>__<name>,
// made and updated with the owner's normal git sign-in. Crew never edits that
// clone, so an update is simply moving it to the branch's latest commit. The
// owner's own checkouts of the repo are never touched.

const { execFile } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const { join, relative, resolve, sep } = require('node:path');

const REPO_RE = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

/** 'owner/name' from 'owner/name', a github.com URL or an SSH remote; null otherwise. */
function parseRepo(input) {
  const m = REPO_RE.exec(String(input || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function createTeams({ crewHome, readSettings, writeSettings, env, exampleDir }) {
  const teamsDir = join(crewHome, 'teams');

  const git = (cwd, args, timeout = 120_000) =>
    new Promise((resolvePromise, reject) =>
      execFile(
        'git',
        args,
        // No prompts: a missing sign-in fails with a message instead of hanging.
        { cwd, timeout, env: { ...env(), GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 8 * 1024 * 1024 },
        (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim())) : resolvePromise(out.trim())),
      ),
    );

  function config() {
    const t = readSettings().team;
    if (t && t.kind === 'github' && parseRepo(t.repo)) return { kind: 'github', repo: parseRepo(t.repo), path: t.path || 'crew', branch: t.branch || 'main' };
    if (t && t.kind === 'folder' && t.dir) return { kind: 'folder', dir: t.dir };
    // Older setting: teamDir.
    const legacy = readSettings().teamDir;
    if (legacy) return { kind: 'folder', dir: legacy };
    return { kind: 'example' };
  }

  const cloneDir = (repo) => join(teamsDir, repo.replace('/', '__'));

  /** The folder the conductor should run, for the current settings. */
  function teamDir(c = config()) {
    if (c.kind === 'github') return join(cloneDir(c.repo), c.path);
    if (c.kind === 'folder') return c.dir;
    return exampleDir;
  }

  /** Clones (first time) a GitHub team into Crew's own folder. */
  async function ensureClone(c) {
    const dir = cloneDir(c.repo);
    if (existsSync(join(dir, '.git'))) return dir;
    mkdirSync(teamsDir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    try {
      await git(teamsDir, ['clone', '--quiet', '--filter=blob:none', '--branch', c.branch, `https://github.com/${c.repo}.git`, dir], 10 * 60_000);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(
        `Could not get ${c.repo} (${c.branch}) from GitHub. Is the name right, and are you signed in to GitHub with git ` +
          `(for example with \`gh auth login\`)?\n\n${err.message}`,
      );
    }
    return dir;
  }

  /**
   * Paths in the repo whose changes count as a team update: the team folder,
   * plus files outside it that crew.config.ts points at with '../' (brand
   * documents, for example).
   */
  function watchedPaths(c, dir) {
    const team = join(dir, c.path);
    const paths = new Set([c.path]);
    try {
      const text = readFileSync(join(team, 'crew.config.ts'), 'utf8');
      for (const m of text.matchAll(/['"`](\.\.\/[^'"`]+)['"`]/g)) {
        const rel = relative(dir, resolve(team, m[1]));
        if (rel && !rel.startsWith('..') && !rel.startsWith(sep)) paths.add(rel);
      }
    } catch {
      // No config: only the team folder.
    }
    return [...paths];
  }

  async function info() {
    const c = config();
    const dir = teamDir(c);
    const out = { ...c, teamDir: dir, ready: existsSync(join(dir, 'agent', 'agent.ts')) };
    if (c.kind === 'github' && existsSync(join(cloneDir(c.repo), '.git'))) {
      try {
        out.revision = await git(cloneDir(c.repo), ['log', '-1', '--format=%h %s']);
      } catch {
        // Shown without a revision.
      }
    }
    return out;
  }

  /**
   * Changes the team. Gets a GitHub team first and checks that the folder is a
   * team (agent/agent.ts) before saving, so a typo never leaves Crew without one.
   */
  async function set(next) {
    let team;
    if (!next || next.kind === 'example') team = undefined;
    else if (next.kind === 'github') {
      const repo = parseRepo(next.repo);
      if (!repo) throw new Error('Enter the repository as owner/name, for example askphill/wakey.');
      team = { kind: 'github', repo, path: String(next.path || 'crew').replace(/^\/+|\/+$/g, ''), branch: String(next.branch || 'main').trim() };
      const dir = await ensureClone(team);
      await git(dir, ['fetch', '--quiet', 'origin', team.branch]);
      await git(dir, ['checkout', '--quiet', '--force', '-B', team.branch, `origin/${team.branch}`]);
    } else if (next.kind === 'folder') {
      if (!next.dir) throw new Error('Choose a folder.');
      team = { kind: 'folder', dir: String(next.dir) };
    } else throw new Error(`Unknown team source: ${next.kind}`);

    const dir = teamDir(team ?? { kind: 'example' });
    if (!existsSync(join(dir, 'agent', 'agent.ts'))) {
      throw new Error(`${dir} is not a Crew team: it has no agent/agent.ts. Check the folder${team?.kind === 'github' ? ' and branch' : ''}.`);
    }
    const settings = readSettings();
    delete settings.teamDir;
    if (team) settings.team = team;
    else delete settings.team;
    writeSettings(settings);
  }

  /** A waiting team update for the sidebar, or null (only GitHub teams have them). */
  async function check() {
    const c = config();
    if (c.kind !== 'github') return null;
    const dir = cloneDir(c.repo);
    if (!existsSync(join(dir, '.git'))) return null;
    try {
      await git(dir, ['fetch', '--quiet', 'origin', c.branch]);
      const count = Number(await git(dir, ['rev-list', '--count', `HEAD..origin/${c.branch}`, '--', ...watchedPaths(c, dir)]));
      if (!count) return null;
      return {
        badge: String(count),
        title: `${count} team change${count === 1 ? '' : 's'} on ${c.repo} (${c.branch}). Click to update the team; running agents stop.`,
        stopsAgents: true,
      };
    } catch (err) {
      console.error('[crew] team check:', err.message);
      return null;
    }
  }

  /** Moves Crew's clone to the branch's latest commit. */
  async function update() {
    const c = config();
    if (c.kind !== 'github') throw new Error('Only a team from GitHub updates from here.');
    const dir = await ensureClone(c);
    await git(dir, ['fetch', '--quiet', 'origin', c.branch]);
    await git(dir, ['checkout', '--quiet', '--force', '-B', c.branch, `origin/${c.branch}`]);
  }

  return { config, teamDir, ensureClone, info, set, check, update, parseRepo };
}

module.exports = { createTeams, parseRepo };
