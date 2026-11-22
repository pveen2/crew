// Grok Build adapter (xAI's `grok` CLI). Headless mode:
//   grok --prompt-file <f> --output-format streaming-json [-s <uuid> | -r <id>] --cwd <dir> --trust
// Grok cannot read the prompt from stdin, so it goes in a file in the run folder.
//
// Isolation: GROK_HOME is Crew's own folder (sign-in, sessions, config with all
// Claude/Cursor compatibility scanning switched off), HOME points at an empty
// folder so ~/.claude, ~/.cursor and ~/.agents are not discovered, and the
// leader socket lives in Crew's folder too.
//
// Instructions (AGENTS.md) and skills (.agents/skills) are read natively.
//
// MCP servers: Grok has no per-run flag, so they go in the session folder's
// .grok/config.toml, which Grok loads because the run passes --trust. The agent
// is denied edits to .grok/ so it cannot add servers itself.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, sharedEngineHome } from '../config.ts';
import { agentBaseEnv, runJsonl, truncate } from './process.ts';
import type { EngineAdapter, EngineEvent, EngineResult, EngineRunOptions } from './types.ts';

const READ_TOOLS = ['read_file', 'grep', 'glob', 'list_dir', 'todo_write'];
// x_search (posts on X) is part of web access: it reaches the same outside world as web search.
const WEB_TOOLS = ['web_search', 'web_fetch', 'x_search'];
const DRAFT_TOOLS = ['write', 'search_replace'];

function tomlString(s: string): string {
  return JSON.stringify(s);
}

function tomlInlineTable(obj: Record<string, string>): string {
  return `{ ${Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)} = ${tomlString(v)}`).join(', ')} }`;
}

function grokEnv(): Record<string, string> {
  const env = agentBaseEnv();
  if (!sharedEngineHome) {
    env.GROK_HOME = paths.engines.grok;
    env.HOME = paths.engines.grokHome;
  }
  // Keep headless output to JSON events only.
  env.RUST_LOG = 'off';
  return env;
}

function leaderSocket(): string[] {
  return sharedEngineHome ? [] : ['--leader-socket', join(paths.engines.grok, 'leader.sock')];
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: { type?: string; text?: string; content?: { type?: string; text?: string } }) => {
      if (typeof c?.text === 'string') return c.text;
      if (c?.content && typeof c.content.text === 'string') return c.content.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export const grok: EngineAdapter = {
  engine: 'grok',

  loginCommand() {
    return {
      command: 'grok',
      args: ['login', ...leaderSocket()],
      env: { GROK_HOME: paths.engines.grok, HOME: paths.engines.grokHome },
    };
  },

  async run(opts: EngineRunOptions): Promise<EngineResult> {
    const started = Date.now();
    mkdirSync(opts.runDir, { recursive: true, mode: 0o700 });
    const env = grokEnv();

    // Per-session MCP servers.
    const toml: string[] = ['# Written by Crew for this run. Do not edit.'];
    for (const [name, s] of Object.entries(opts.mcpServers)) {
      Object.assign(env, s.secretEnv);
      toml.push(
        '',
        `[mcp_servers.${name}]`,
        `command = ${tomlString(s.command)}`,
        `args = [${s.args.map(tomlString).join(', ')}]`,
        // Grok has no env forwarding by name: the bridge token goes in the file
        // (it only works for this session). Other secrets are inherited from the process.
        `env = ${tomlInlineTable({ ...s.env, ...(name === 'crew' ? s.secretEnv : {}) })}`,
        'enabled = true',
        'startup_timeout_sec = 30',
        `tool_timeout_sec = ${s.toolTimeoutSec}`,
      );
    }
    const grokDir = join(opts.workdir, '.grok');
    mkdirSync(grokDir, { recursive: true });
    writeFileSync(join(grokDir, 'config.toml'), toml.join('\n') + '\n', { mode: 0o600 });

    const promptFile = join(opts.runDir, `grok-prompt-${Date.now()}.md`);
    writeFileSync(promptFile, opts.prompt, { mode: 0o600 });

    const tools = [...READ_TOOLS, ...(opts.webAccess ? WEB_TOOLS : []), ...(opts.permissions === 'draft' ? DRAFT_TOOLS : [])];
    const args = [
      '--prompt-file', promptFile,
      '--output-format', 'streaming-json',
      '--cwd', opts.workdir,
      '--trust',
      '--permission-mode', 'dontAsk',
      '--tools', tools.join(','),
      '--no-subagents',
      ...(opts.webAccess ? [] : ['--disable-web-search']),
      '--max-turns', '80',
      ...leaderSocket(),
    ];
    for (const [name, s] of Object.entries(opts.mcpServers)) {
      for (const t of s.allowTools ?? ['*']) args.push('--allow', `mcp__${name}__${t}`);
    }
    if (opts.permissions === 'draft') args.push('--allow', 'Write(./drafts/**)', '--allow', 'Edit(./drafts/**)');
    args.push('--deny', 'Write(./.grok/**)', '--deny', 'Edit(./.grok/**)');
    for (const p of opts.denyPaths) {
      for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write']) args.push('--deny', `${tool}(${p})`, '--deny', `${tool}(${p}/**)`);
    }
    if (opts.model) args.push('-m', opts.model);
    if (opts.reasoning) args.push('--effort', opts.reasoning);
    if (opts.resumeId) args.push('-r', opts.resumeId);
    else if (opts.newSessionId) args.push('-s', opts.newSessionId);

    let engineSessionId: string | null = opts.resumeId ?? opts.newSessionId ?? null;
    let announced = false;
    let lastText = '';
    let textBuf = '';
    let thoughtBuf = '';
    let failure: string | undefined;
    let ended = false;
    const emit = (e: EngineEvent) => opts.onEvent(e);

    // streaming-json sends text and thoughts in pieces; join them into whole messages.
    const flush = () => {
      if (thoughtBuf.trim()) emit({ kind: 'thinking', text: thoughtBuf });
      thoughtBuf = '';
      if (textBuf.trim()) {
        lastText = textBuf;
        emit({ kind: 'text', text: textBuf });
      }
      textBuf = '';
    };

    const run = await runJsonl({
      command: 'grok',
      args,
      cwd: opts.workdir,
      env,
      stdin: '',
      signal: opts.signal,
      onSpawn: opts.onSpawn,
      onLine(msg) {
        if (!announced && engineSessionId) {
          announced = true;
          emit({ kind: 'session', engineSessionId });
        }
        switch (msg.type) {
          case 'text':
            if (thoughtBuf) {
              emit({ kind: 'thinking', text: thoughtBuf });
              thoughtBuf = '';
            }
            textBuf += String(msg.data ?? '');
            break;
          case 'thought':
            thoughtBuf += String(msg.data ?? '');
            break;
          case 'tool_call': {
            flush();
            emit({
              kind: 'tool_call',
              callId: String(msg.toolCallId),
              name: String(msg.toolName ?? msg.title ?? 'tool'),
              input: msg.rawInput ?? {},
            });
            break;
          }
          case 'tool_call_update': {
            const status = String(msg.status ?? '');
            if (status !== 'completed' && status !== 'failed' && status !== 'error' && status !== 'cancelled') break;
            const text = contentText(msg.content) || (msg.rawOutput === undefined ? '' : JSON.stringify(msg.rawOutput));
            emit({ kind: 'tool_result', callId: String(msg.toolCallId), output: truncate(text), isError: status !== 'completed' });
            break;
          }
          case 'error':
            flush();
            failure = String(msg.message ?? 'Grok error');
            break;
          case 'end':
            flush();
            ended = true;
            if (typeof msg.sessionId === 'string' && msg.sessionId) {
              engineSessionId = msg.sessionId;
              if (!announced) emit({ kind: 'session', engineSessionId });
              announced = true;
            }
            if (msg.stopReason && msg.stopReason !== 'end_turn') {
              failure = failure ?? `Grok stopped: ${String(msg.stopReason)}`;
            }
            break;
        }
      },
    });
    flush();

    const durationMs = Date.now() - started;
    if (run.aborted) return { ok: false, engineSessionId, finalText: lastText, error: 'Stopped', durationMs };
    if (!ended || failure || run.exitCode !== 0) {
      const error = failure ?? (run.stderrTail || `grok exited with code ${run.exitCode}`);
      const resumeFailed = Boolean(opts.resumeId) && /not found|no such session|does not exist|unknown session/i.test(error + run.stderrTail);
      return { ok: false, engineSessionId, finalText: lastText, error: notSignedInHint(error), resumeFailed, durationMs };
    }
    return { ok: true, engineSessionId, finalText: lastText, durationMs };
  },
};

function notSignedInHint(error: string): string {
  if (/not (signed|logged) in|login|unauthori[sz]ed|401|auth/i.test(error)) {
    return `${error}\n\nGrok is not signed in for Crew. Run: pnpm crew login grok`;
  }
  return error;
}
