// Claude Code adapter. Headless mode:
//   claude -p --input-format stream-json --output-format stream-json --replay-user-messages --verbose
//          [--session-id <uuid> | --resume <id>]
// The prompt goes in on stdin as a JSON user message, and stdin stays open
// until the turn's result, so owner messages can be written in mid-turn
// (steering). Claude Code echoes each one back (isReplay) once the agent has
// read it, between steps. Crew's own config folder via CLAUDE_CONFIG_DIR.
// Instructions come from AGENTS.md (read natively) and skills from .agents/skills
// (loaded with --plugin-dir .agents); no CLAUDE.md or .claude/ folder.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, sharedEngineHome } from '../config.ts';
import { agentBaseEnv, runJsonl, truncate, type StdinHandle } from './process.ts';
import type { EngineAdapter, EngineEvent, EngineResult, EngineRunOptions } from './types.ts';

function userLine(text: string, uuid: string): string {
  return JSON.stringify({ type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } });
}

// No Task: specialists do not delegate, and the lead delegates only through Crew's tools.
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Skill', 'TodoWrite'];
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const DRAFT_TOOLS = ['Write', 'Edit'];

function claudeEnv(): Record<string, string> {
  const env = agentBaseEnv();
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (!sharedEngineHome) env.CLAUDE_CONFIG_DIR = paths.engines.claude;
  // A specialist call or an owner approval can take many minutes.
  env.MCP_TOOL_TIMEOUT = String(60 * 60 * 1000);
  env.MCP_TIMEOUT = String(30 * 1000);
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) => (c?.type === 'text' ? (c.text ?? '') : `[${c?.type ?? 'content'}]`))
      .join('\n');
  }
  return JSON.stringify(content);
}

export const claudeCode: EngineAdapter = {
  engine: 'claude-code',

  loginCommand() {
    return { command: 'claude', args: ['auth', 'login'], env: { CLAUDE_CONFIG_DIR: paths.engines.claude } };
  },

  async run(opts: EngineRunOptions): Promise<EngineResult> {
    const started = Date.now();
    mkdirSync(opts.runDir, { recursive: true, mode: 0o700 });

    const env = claudeEnv();
    const mcpServers: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(opts.mcpServers)) {
      // Secrets reach the MCP server through the inherited process environment.
      Object.assign(env, s.secretEnv);
      mcpServers[name] = { type: 'stdio', command: s.command, args: s.args, env: s.env };
    }
    const mcpFile = join(opts.runDir, 'claude-mcp.json');
    writeFileSync(mcpFile, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });

    const deny: string[] = [];
    for (const p of opts.denyPaths) {
      // Claude Code writes absolute paths as //abs; cover the path itself and anything below it.
      for (const tool of ['Read', 'Edit', 'Write', 'Glob', 'Grep']) deny.push(`${tool}(/${p})`, `${tool}(/${p}/**)`);
    }
    const settingsFile = join(opts.runDir, 'claude-settings.json');
    writeFileSync(settingsFile, JSON.stringify({ permissions: { deny } }, null, 2), { mode: 0o600 });

    const web = opts.webAccess ? WEB_TOOLS : [];
    const tools = [...READ_TOOLS, ...web, ...(opts.permissions === 'draft' ? DRAFT_TOOLS : [])];
    const allowed = [
      ...READ_TOOLS,
      ...web,
      ...(opts.permissions === 'draft' ? ['Write(./drafts/**)', 'Edit(./drafts/**)'] : []),
      ...Object.entries(opts.mcpServers).flatMap(([n, s]) => (s.allowTools ? s.allowTools.map((t) => `mcp__${n}__${t}`) : [`mcp__${n}`])),
    ];

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--model', opts.model,
      '--permission-mode', 'dontAsk',
      '--tools', tools.join(','),
      '--allowedTools', allowed.join(','),
      '--setting-sources', 'project',
      '--settings', settingsFile,
      '--strict-mcp-config',
      '--mcp-config', mcpFile,
    ];
    // Skills live in .agents/skills (shared with Codex and Grok); Claude Code loads them as a plugin folder.
    const agentsDir = join(opts.workdir, '.agents');
    if (existsSync(join(agentsDir, 'skills'))) args.push('--plugin-dir', agentsDir);
    if (opts.reasoning) args.push('--effort', opts.reasoning);
    if (opts.resumeId) args.push('--resume', opts.resumeId);
    else if (opts.newSessionId) args.push('--session-id', opts.newSessionId);

    let engineSessionId: string | null = opts.resumeId ?? opts.newSessionId ?? null;
    let finalText = '';
    let lastText = '';
    let resultError: string | undefined;
    let gotResult = false;
    const emit = (e: EngineEvent) => opts.onEvent(e);

    // Owner messages written in mid-turn that the agent has not read yet.
    const unread = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
    let stdin: StdinHandle | null = null;
    let steerOpen = true;
    const closeSteer = () => {
      if (!steerOpen) return;
      steerOpen = false;
      opts.onSteer?.(null);
    };

    const run = await runJsonl({
      command: 'claude',
      args,
      cwd: opts.workdir,
      env,
      stdin: userLine(opts.prompt, randomUUID()) + '\n',
      keepStdinOpen: true,
      onStdin(io) {
        stdin = io;
        opts.onSteer?.((text) => {
          if (!steerOpen) return Promise.reject(new Error('The turn has ended'));
          const uuid = randomUUID();
          return new Promise<void>((resolve, reject) => {
            unread.set(uuid, { resolve, reject });
            if (!io.write(userLine(text, uuid))) {
              unread.delete(uuid);
              reject(new Error('The turn has ended'));
            }
          });
        });
      },
      signal: opts.signal,
      onSpawn: opts.onSpawn,
      onLine(msg) {
        const type = msg.type as string;
        if (type === 'user' && msg.isReplay) {
          // The agent has read an owner message (or the first prompt).
          const uuid = String(msg.uuid ?? '');
          unread.get(uuid)?.resolve();
          unread.delete(uuid);
          return;
        }
        if (type === 'system' && msg.subtype === 'init') {
          engineSessionId = msg.session_id as string;
          emit({ kind: 'session', engineSessionId });
          return;
        }
        // Events from Claude Code's own subagents (Task tool) stay inside the card.
        if (msg.parent_tool_use_id) return;

        if (type === 'assistant') {
          const content = (msg.message as { content?: Array<Record<string, unknown>> })?.content ?? [];
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              lastText = block.text;
              emit({ kind: 'text', text: block.text });
            } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
              emit({ kind: 'thinking', text: block.thinking });
            } else if (block.type === 'tool_use') {
              emit({ kind: 'tool_call', callId: String(block.id), name: String(block.name), input: block.input });
            }
          }
        } else if (type === 'user') {
          const content = (msg.message as { content?: unknown })?.content;
          if (!Array.isArray(content)) return;
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === 'tool_result') {
              emit({
                kind: 'tool_result',
                callId: String(block.tool_use_id),
                output: truncate(toolResultText(block.content)),
                isError: Boolean(block.is_error),
              });
            }
          }
        } else if (type === 'result') {
          // No more steering. A message written just before the result was not
          // read in this turn: Claude Code answers it in one more turn on the
          // same process, and only that turn's result counts.
          closeSteer();
          gotResult = true;
          if (typeof msg.session_id === 'string') engineSessionId = msg.session_id;
          if (msg.is_error || msg.subtype !== 'success') {
            resultError = String(msg.result ?? (msg.errors as unknown) ?? msg.subtype ?? 'Claude Code reported an error');
          } else {
            resultError = undefined;
            finalText = String(msg.result ?? '');
          }
          if (unread.size === 0) stdin?.end();
        }
      },
    });

    closeSteer();
    for (const u of unread.values()) u.reject(new Error('The turn ended before the agent read it'));
    unread.clear();

    const durationMs = Date.now() - started;
    if (run.aborted) {
      return { ok: false, engineSessionId, finalText: lastText, error: 'Stopped', durationMs };
    }
    const resumeFailed = Boolean(opts.resumeId) && /no conversation found/i.test(run.stderrTail + (resultError ?? ''));
    if (!gotResult || resultError || run.exitCode !== 0) {
      const error = resultError ?? (run.stderrTail || `claude exited with code ${run.exitCode}`);
      return { ok: false, engineSessionId, finalText: finalText || lastText, error: notSignedInHint(error), resumeFailed, durationMs };
    }
    return { ok: true, engineSessionId, finalText: finalText || lastText, durationMs };
  },
};

function notSignedInHint(error: string): string {
  if (/not logged in|login|authenticate|invalid api key|oauth/i.test(error)) {
    return `${error}\n\nClaude Code is not signed in for Crew. Run: pnpm crew login claude`;
  }
  return error;
}
