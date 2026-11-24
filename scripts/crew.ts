// pnpm crew <command>
//
//   login claude|codex|grok|antigravity  Sign an engine in, in Crew's own config folder
//   doctor                            Check engine sign-in, team definition and conductor
//   ask "<text>" [--role gm]          Start a thread and follow it until it is done
//   send <threadId> "<text>" [--session <id>]
//   resume <threadId>                 Resume an interrupted thread
//   status                            Threads, Inbox and who is working on what
//   show <threadId>                   Print a thread
//   approve <inboxId> | deny <inboxId>   Decide on a tool call that waits for you
//   info                              What Crew found in packages/crew (like `eve info`)
//   translate <agent> [claude-code|codex|grok|antigravity] [dir]   Show what an agent becomes for an engine
//   try <agent> "<prompt>" --models claude-code/opus,codex/gpt-6.2-sol@high [--attach <image|folder>]
//   eval [filter] [--repeat n] [--strict] [--keep]   Run packages/crew/evals against the conductor
//   report                            Time, handoffs and verdicts per thread
//   verdict <threadId> --quality 1-5 --app 1-5 ["note"]

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import type { ConductorInfo, CrewEvent, Engine, ServerMessage, StateResponse, Thread, ThreadDetailResponse } from '@crew/protocol';
import { TEAM_ROOT, listEvalFiles, loadCrew, subagentToolName } from '@crew/sdk/load';
import { ensureDirs, paths, sharedEngineHome } from '@crew/conductor/config';
import { engines } from '@crew/conductor/engines';
import { crewTools, translateAgent } from '@crew/conductor/translate';
import { accessHeaders, api, bold, conductor, cyan, dim, fmtDuration, green, red, yellow } from './api.ts';

const argv = process.argv.slice(2).filter(arg => arg !== '--access-stdin');
const cmd = argv.shift();

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}

function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Crew tool calls that have their own event (subagent card, preview, question, status). */
let quietTools = new Set<string>(['ask_owner', 'show_preview', 'save_artifact']);
async function loadQuietTools(): Promise<void> {
  const crew = await loadCrew().catch(() => undefined);
  if (!crew) return;
  for (const a of Object.values(crew.agents)) {
    if (!a.isLead) quietTools.add(subagentToolName(a.name));
    for (const m of a.memories) quietTools.add(`${m.name}__save_memory`).add(`${m.name}__remove_memory`);
  }
}

function printEvent(e: CrewEvent, roleOf: (sessionId: string) => string): void {
  const who = cyan(`[${roleOf(e.sessionId)}]`);
  switch (e.type) {
    case 'message':
      if (e.role === 'user') console.log(`${who} ${bold('owner:')} ${e.text}`);
      else console.log(`${who} ${e.text}\n`);
      break;
    case 'tool_call':
      if (!quietTools.has(e.name.replace(/^mcp__crew__/, ''))) console.log(`${who} ${dim(`→ ${e.name.replace(/^mcp__/, '')} ${oneLine(JSON.stringify(e.input ?? {}), 100)}`)}`);
      break;
    case 'tool_result':
      if (e.isError) console.log(`${who} ${red(`✗ ${oneLine(e.output, 140)}`)}`);
      break;
    case 'subagent_started':
      console.log(`${who} ${yellow(`⇢ asks ${e.role} (${e.engine} · ${e.model})`)}: ${dim(oneLine(e.brief))}`);
      break;
    case 'subagent_done':
      console.log(`${who} ${yellow(`⇠ ${e.role} ${e.status} in ${fmtDuration(e.durationMs)}`)}`);
      break;
    case 'needs_you':
      console.log(`${who} ${red('needs you:')} ${e.question}`);
      break;
    case 'approval':
      console.log(`${who} ${red(`waits for approval: ${e.toolName}`)} ${dim(oneLine(JSON.stringify(e.input ?? {}), 120))}`);
      console.log(dim(`    pnpm crew approve ${e.inboxId}   ·   pnpm crew deny ${e.inboxId}`));
      break;
    case 'approval_done':
      console.log(`${who} ${e.approved ? green(`✓ approved ${e.toolName}`) : red(`✗ denied ${e.toolName}`)}`);
      break;
    case 'preview':
      console.log(`${who} ${green(`▣ preview: ${e.title}`)} ${dim(`(${e.content.length} chars)`)}`);
      break;
    case 'turn_done':
      if (e.status !== 'done') console.log(`${who} ${red(`turn ${e.status}${e.error ? `: ${oneLine(e.error, 300)}` : ''}`)}`);
      break;
    case 'status':
      console.log(`${who} ${dim(e.text)}`);
      break;
  }
}

/** Follow a thread over the WebSocket until nothing in it is running. */
async function follow(threadId: string, sinceId = 0): Promise<void> {
  const info = conductor();
  await loadQuietTools();
  const roles = new Map<string, string>();
  const refresh = async () => {
    const d = await api<ThreadDetailResponse>('GET', `/api/threads/${threadId}`);
    for (const s of d.sessions) roles.set(s.id, s.role);
    return d;
  };
  const detail = await refresh();
  for (const e of detail.events) if (e.id > sinceId) printEvent(e, (id) => roles.get(id) ?? '?');
  let seen = Math.max(sinceId, ...detail.events.map((e) => e.id));
  const started = Date.now();

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?token=${encodeURIComponent(info.token)}`, { headers: accessHeaders() });
    let finished = false;
    const finish = async (t: Thread) => {
      if (finished) return;
      finished = true;
      const d = await refresh();
      for (const e of d.events) if (e.id > seen) printEvent(e, (id) => roles.get(id) ?? '?');
      const handoffs = d.events.filter((e) => e.type === 'subagent_started').length;
      console.log(dim(`\n— ${t.status} · ${fmtDuration(Date.now() - started)} · ${handoffs} handoff(s) · thread ${t.id}`));
      if (t.status === 'needs_you') {
        const open = (await api<StateResponse>('GET', '/api/state')).inbox.filter((i) => i.threadId === t.id);
        for (const i of open) {
          if (i.kind === 'approval') console.log(yellow(`  waiting for approval: pnpm crew approve ${i.id}  ·  pnpm crew deny ${i.id}`));
          if (i.kind === 'needs_you') console.log(yellow(`  waiting for your answer: pnpm crew send ${t.id} "…"`));
        }
      }
      ws.close();
      resolve();
    };
    // The thread may have finished before the socket opened: check once it is open.
    ws.on('open', async () => {
      const d = await refresh();
      if (d.thread.status !== 'running') await finish(d.thread);
    });
    ws.on('message', async (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      if (msg.kind === 'session' && msg.session.threadId === threadId) roles.set(msg.session.id, msg.session.role);
      if (msg.kind === 'event' && msg.event.threadId === threadId && msg.event.id > seen) {
        seen = msg.event.id;
        if (!roles.has(msg.event.sessionId)) await refresh();
        printEvent(msg.event, (id) => roles.get(id) ?? '?');
      }
      if (msg.kind === 'thread' && msg.thread.id === threadId && msg.thread.status !== 'running') await finish(msg.thread);
    });
    ws.on('error', (err) => {
      console.error(red(String(err)));
      resolve();
    });
  });
}

async function main() {
  ensureDirs();
  switch (cmd) {
    case 'login': {
      const which = argv[0];
      const adapter =
        which === 'claude' ? engines['claude-code'] : which === 'codex' || which === 'grok' || which === 'antigravity' ? engines[which] : undefined;
      if (!adapter) throw new Error('Usage: pnpm crew login claude|codex|grok|antigravity');
      if (which === 'antigravity') console.log(dim('Antigravity opens a Google sign-in in your browser. When it is ready, type /quit.'));
      const { command, args, env } = adapter.loginCommand();
      console.log(dim(`Signing ${which} in for Crew (config folder: ${Object.values(env)[0]})`));
      const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
      await new Promise((r) => child.on('close', r));
      return;
    }

    case 'doctor': {
      const { spawnSync } = await import('node:child_process');
      const shared = sharedEngineHome;
      const note = shared ? ' (shared with your personal setup, dev mode)' : '';
      const run = (cmd: string, args: string[], env: Record<string, string>) => {
        const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...(shared ? {} : env) } });
        return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
      };
      const claude = run('claude', ['auth', 'status'], { CLAUDE_CONFIG_DIR: paths.engines.claude });
      let claudeUser = '';
      try {
        const j = JSON.parse(claude.out) as { loggedIn?: boolean; email?: string };
        if (j.loggedIn) claudeUser = j.email ?? 'signed in';
      } catch {}
      console.log(claudeUser ? `${green('✓')} Claude Code: ${claudeUser}${note}` : `${red('✗')} Claude Code: not signed in for Crew. Run: pnpm crew login claude`);
      const codexStatus = run('codex', ['login', 'status'], { CODEX_HOME: paths.engines.codex });
      console.log(
        codexStatus.ok && !/not logged in/i.test(codexStatus.out)
          ? `${green('✓')} Codex: ${codexStatus.out.split('\n').at(-1)}${note}`
          : `${red('✗')} Codex: not signed in for Crew. Run: pnpm crew login codex`,
      );
      const grokModels = run('grok', ['models', ...(shared ? [] : ['--leader-socket', `${paths.engines.grok}/leader.sock`])], {
        GROK_HOME: paths.engines.grok,
        HOME: paths.engines.grokHome,
      });
      console.log(
        grokModels.ok && !/not authenticated|not (signed|logged) in|grok login/i.test(grokModels.out)
          ? `${green('✓')} Grok: signed in${note}`
          : `${red('✗')} Grok: not signed in for Crew. Run: pnpm crew login grok`,
      );
      const agy = run('agy', ['models'], { HOME: paths.engines.antigravityHome });
      console.log(
        agy.ok && !/sign in/i.test(agy.out)
          ? `${green('✓')} Antigravity: signed in (${agy.out.split('\n').filter((l) => /neon|gemini/i.test(l)).length} Gemini models)${note}`
          : `${red('✗')} Antigravity: not signed in. Run: pnpm crew login antigravity`,
      );
      const crew = await loadCrew();
      console.log(`${green('✓')} Team: ${Object.values(crew.agents).map((a) => `${a.name} (${a.engine}/${a.model})`).join(', ')}`);
      const shopifyStore = crew.config.shopify?.store ?? '';
      const shopify = spawnSync(
        'shopify',
        ['store', 'execute', '--store', shopifyStore, '--json', '--query', '{ shop { name } }'],
        { encoding: 'utf8', timeout: 20_000 },
      );
      const shopifyErrorCode = (shopify.error as NodeJS.ErrnoException | undefined)?.code;
      if (shopifyErrorCode === 'ENOENT') {
        console.log(`${yellow('!')} Shopify: CLI not found on PATH`);
      } else if (shopify.status === 0) {
        console.log(`${green('✓')} Shopify: signed in to ${shopifyStore}`);
      } else if (/no stored app authentication|stored app authentication.*(?:expired|no longer valid)/i.test(shopify.stderr ?? '')) {
        console.log(`${yellow('!')} Shopify: not signed in to ${shopifyStore}. Run the Shopify CLI auth step in README.md.`);
      } else {
        const reason = shopifyErrorCode === 'ETIMEDOUT' ? 'check timed out after 20 seconds' : 'store query failed';
        console.log(`${yellow('!')} Shopify: could not verify sign-in to ${shopifyStore} (${reason})`);
      }
      try {
        const info = JSON.parse(readFileSync(paths.info, 'utf8')) as ConductorInfo;
        await api<StateResponse>('GET', '/api/state');
        console.log(`${green('✓')} Conductor running on port ${info.port}`);
      } catch (error) {
        console.log(`${red('✗')} Conductor check failed: ${(error as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }

    case 'ask': {
      const role = flag('role');
      const text = argv.join(' ').trim();
      if (!text) throw new Error('Usage: pnpm crew ask "<text>" [--role gm]');
      const thread = await api<Thread>('POST', '/api/threads', { text, role });
      console.log(dim(`thread ${thread.id}`));
      await follow(thread.id);
      return;
    }

    case 'send': {
      const sessionId = flag('session');
      const [threadId, ...rest] = argv;
      if (!threadId || !rest.length) throw new Error('Usage: pnpm crew send <threadId> "<text>" [--session <id>]');
      const before = await api<ThreadDetailResponse>('GET', `/api/threads/${threadId}`);
      await api('POST', `/api/threads/${threadId}/messages`, { text: rest.join(' '), sessionId });
      await follow(threadId, Math.max(0, ...before.events.map((e) => e.id)));
      return;
    }

    case 'resume': {
      const [threadId] = argv;
      if (!threadId) throw new Error('Usage: pnpm crew resume <threadId>');
      const before = await api<ThreadDetailResponse>('GET', `/api/threads/${threadId}`);
      await api('POST', `/api/threads/${threadId}/resume`);
      await follow(threadId, Math.max(0, ...before.events.map((e) => e.id)));
      return;
    }

    case 'show': {
      const [threadId] = argv;
      const d = await api<ThreadDetailResponse>('GET', `/api/threads/${threadId}`);
      const roles = new Map(d.sessions.map((s) => [s.id, s.role]));
      console.log(bold(d.thread.title), dim(`· ${d.thread.status}`));
      for (const e of d.events) printEvent(e, (id) => roles.get(id) ?? '?');
      return;
    }

    case 'status': {
      const s = await api<StateResponse>('GET', '/api/state');
      console.log(bold('Threads'));
      for (const t of s.threads.slice(0, 20)) console.log(`  ${t.id}  ${t.status.padEnd(11)} ${t.title}`);
      console.log(bold('\nInbox'));
      for (const i of s.inbox) console.log(`  ${i.kind.padEnd(11)} ${i.title} ${dim(`${i.threadId}${i.kind === 'approval' ? ` · pnpm crew approve|deny ${i.id}` : ''}`)}`);
      if (!s.inbox.length) console.log(dim('  empty'));
      console.log(bold('\nWorking'));
      for (const a of s.activity) console.log(`  ${a.role.padEnd(20)} ${a.status.padEnd(11)} ${a.doing} ${dim(`· ${a.threadTitle}`)}`);
      if (!s.activity.length) console.log(dim('  nobody'));
      return;
    }

    case 'approve':
    case 'deny': {
      const [inboxId] = argv;
      if (!inboxId) throw new Error(`Usage: pnpm crew ${cmd} <inboxId>  (see pnpm crew status)`);
      const pending = (await api<StateResponse>('GET', '/api/state')).inbox.find((i) => i.id === inboxId);
      const before = pending ? await api<ThreadDetailResponse>('GET', `/api/threads/${pending.threadId}`) : undefined;
      const item = await api<{ threadId: string }>('POST', `/api/inbox/${inboxId}/${cmd}`);
      console.log(cmd === 'approve' ? green('Approved.') : yellow('Denied.'));
      await follow(item.threadId, before ? Math.max(0, ...before.events.map((e) => e.id)) : 0);
      return;
    }

    case 'roles':
    case 'info': {
      const crew = await loadCrew();
      const rel = (p: string) => relative(TEAM_ROOT, p) || '.';
      console.log(bold('Crew') + dim(` · ${TEAM_ROOT}`));
      console.log(dim(`limits: specialist turn ${crew.limits.turnTimeoutMinutes} min, lead turn ${crew.limits.threadTurnTimeoutMinutes} min\n`));
      for (const a of Object.values(crew.agents)) {
        console.log(`${bold(a.label)} ${dim(`(${a.name}${a.isLead ? ', lead' : ''}) · ${rel(a.dir)}`)}`);
        if (a.description) console.log(`  ${a.description}`);
        console.log(`  model       ${a.engine}/${a.model}${a.reasoning ? `@${a.reasoning}` : ''} · ${a.permissions} · web ${a.webAccess ? 'on' : 'off'}`);
        const tools = crewTools(crew, a, a.isLead).map((t) => {
          const own = a.tools.find((o) => o.name === t.name);
          return own?.approval ? `${t.name} (approval)` : t.name;
        });
        console.log(`  tools       ${tools.join(', ')}`);
        if (a.def.approval) console.log(`  approval    custom policy in agent.ts`);
        for (const [name, c] of Object.entries(a.connections)) console.log(`  connection  ${name}: ${c.tools.allow.join(', ')}`);
        if (a.skills.length) console.log(`  skills      ${a.skills.map((sk) => (sk.shared ? `${sk.name} (lib)` : sk.name)).join(', ')}`);
        if (a.memories.length) console.log(`  memory      ${a.memories.map((m) => m.name).join(', ')}`);
        console.log('');
      }
      const evals = listEvalFiles();
      console.log(`${bold('Evals')} ${dim(`(${evals.length})`)}  ${evals.map((e) => e.id).join(', ') || dim('none')}`);
      console.log(dim(`\nEngine sign-in: ${sharedEngineHome ? 'shared with your personal setup (dev mode)' : `Crew's own, in ${dirname(paths.engines.claude)}`}`));
      return;
    }

    case 'translate': {
      const [name, engineArg, dirArg] = argv;
      const crew = await loadCrew();
      const agent = crew.agents[name ?? ''];
      if (!agent) throw new Error(`Usage: pnpm crew translate <agent> [claude-code|codex|grok|antigravity] [dir]. Agents: ${Object.keys(crew.agents).join(', ')}`);
      const engine: Engine =
        engineArg === 'codex' || engineArg === 'claude-code' || engineArg === 'grok' || engineArg === 'antigravity' ? engineArg : agent.engine;
      const dir = dirArg ?? mkdtempSync(join(tmpdir(), `crew-${agent.name}-${engine}-`));
      const files = translateAgent({ crew, agent, engine, workdir: dir, canDelegate: agent.isLead,
        memories: agent.memories.map((m) => ({ name: m.name, description: m.def.description, entries: [] })),
      });
      console.log(bold(`${agent.label} for ${engine}:`));
      for (const f of files) console.log('  ' + f.replace(dir + '/', ''));
      console.log(dim(`\nWritten to ${dir}`));
      return;
    }

    case 'eval': {
      const { runEvals } = await import('./eval.ts');
      const repeat = flag('repeat');
      const strict = argv.includes('--strict');
      const keep = argv.includes('--keep');
      const [filter] = argv.filter((a) => !a.startsWith('--'));
      process.exitCode = await runEvals({ filter, repeat: repeat ? Number(repeat) : undefined, strict, keep });
      return;
    }

    case 'try': {
      const { runTry } = await import('./try.ts');
      const models = flag('models');
      const attach = flag('attach');
      const noOpen = argv.includes('--no-open');
      const [role, ...rest] = argv.filter((a) => a !== '--no-open');
      await runTry({ role: role ?? '', prompt: rest.join(' '), models: models ?? '', attach, open: !noOpen });
      return;
    }

    case 'report': {
      const db = new DatabaseSync(paths.db, { readOnly: true });
      const threads = db.prepare('SELECT * FROM threads ORDER BY created_at').all() as Array<Record<string, string | number>>;
      const rows = threads.map((t) => {
        const turns = db.prepare('SELECT MIN(started_at) a, MAX(COALESCE(ended_at, started_at)) b FROM turns WHERE thread_id = ?').get(t.id) as { a: number; b: number };
        const handoffs = (db.prepare("SELECT COUNT(*) n FROM events WHERE thread_id = ? AND type = 'subagent_started'").get(t.id) as { n: number }).n;
        const roles = (db.prepare('SELECT DISTINCT role || \' (\' || engine || \')\' r FROM sessions WHERE thread_id = ?').all(t.id) as Array<{ r: string }>).map((r) => r.r);
        const v = db.prepare('SELECT * FROM verdicts WHERE thread_id = ?').get(t.id) as { quality?: number; app?: number; note?: string } | undefined;
        return { id: t.id, title: t.title, status: t.status, time: turns.a ? fmtDuration(turns.b - turns.a) : '-', handoffs, roles: roles.join(', '), quality: v?.quality ?? '', app: v?.app ?? '', note: v?.note ?? '' };
      });
      console.log('| Thread | Task | Status | Time | Handoffs | Agents | Quality | App | Note |');
      console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const r of rows) console.log(`| ${r.id} | ${r.title} | ${r.status} | ${r.time} | ${r.handoffs} | ${r.roles} | ${r.quality} | ${r.app} | ${r.note} |`);
      return;
    }

    case 'verdict': {
      const quality = flag('quality');
      const app = flag('app');
      const [threadId, ...note] = argv;
      if (!threadId) throw new Error('Usage: pnpm crew verdict <threadId> --quality 1-5 --app 1-5 ["note"]');
      const db = new DatabaseSync(paths.db);
      db.prepare(
        'INSERT INTO verdicts (thread_id, quality, app, note, ts) VALUES (?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET quality = excluded.quality, app = excluded.app, note = excluded.note, ts = excluded.ts',
      ).run(threadId, quality ? Number(quality) : null, app ? Number(app) : null, note.join(' '), Date.now());
      console.log(green('Saved.'));
      return;
    }

    default:
      const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
      console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}

main().catch((err) => {
  console.error(red((err as Error).message));
  process.exit(1);
});
