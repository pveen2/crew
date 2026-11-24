// Google Antigravity CLI adapter (`agy`), for Gemini models on the owner's
// Google subscription (Gemini 4 Neon and others). Headless mode:
//   agy -p <prompt> --output-format stream-json --settings <file> --model <id> [--conversation <id>]
//
// Antigravity reads AGENTS.md and .agents/skills natively, and per-workspace
// MCP servers from .agents/mcp_config.json, so it fits the shared session layout
// without engine-specific files.
//
// Sign-in lives in the OS keyring (`pnpm crew login antigravity` runs `agy`
// once). Its settings live in ~/.gemini; Crew runs it with HOME pointed at
// Crew's own folder so personal settings, MCP servers and skills stay out.
//
// Permissions: per-run settings (--settings, never saved). With the default
// `request-review` mode anything not explicitly allowed is soft-denied in
// headless mode, so the allow rules are the whole policy:
//   read_file(<session folder>), mcp(crew/*), mcp(<connection>/<allowed tool>),
//   write_file(<session folder>/drafts) for draft agents,
// plus deny rules for shell commands, Crew's deny paths and (without web
// access) every URL.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, sharedEngineHome } from '../config.ts';
import { agentBaseEnv, runJsonl, truncate } from './process.ts';
import { addUsage, readUsage, type EngineAdapter, type EngineEvent, type EngineResult, type EngineRunOptions } from './types.ts';
import type { Usage } from '@crew/protocol';

function agyEnv(): Record<string, string> {
  const env = agentBaseEnv();
  if (!sharedEngineHome) env.HOME = paths.engines.antigravityHome;
  return env;
}

type Json = Record<string, unknown>;

/** Antigravity nests an event's data under its name ({"event":"init","init":{…}}); accept it flat too. */
function payload(msg: Json): Json {
  const nested = msg[String(msg.event)];
  return nested && typeof nested === 'object' ? { ...msg, ...(nested as Json) } : msg;
}

function infoText(info: unknown): string {
  if (info == null) return '';
  if (typeof info === 'string') return info;
  const o = info as Json;
  for (const k of ['output', 'result', 'response', 'text', 'content']) if (typeof o[k] === 'string') return o[k] as string;
  return JSON.stringify(info);
}

export const antigravity: EngineAdapter = {
  engine: 'antigravity',

  loginCommand() {
    // Interactive agy: sign in with Google in the browser, then /quit.
    return { command: 'agy', args: [], env: { HOME: paths.engines.antigravityHome } };
  },

  async run(opts: EngineRunOptions): Promise<EngineResult> {
    const started = Date.now();
    mkdirSync(opts.runDir, { recursive: true, mode: 0o700 });
    const env = agyEnv();

    // MCP servers for this session. Secrets stay out of the file: the servers
    // inherit them from agy's own environment.
    const mcpServers: Record<string, unknown> = {};
    const allow: string[] = [`read_file(${opts.workdir})`];
    for (const [name, s] of Object.entries(opts.mcpServers)) {
      Object.assign(env, s.secretEnv);
      mcpServers[name] = { command: s.command, args: s.args, env: s.env };
      if (s.allowTools) for (const t of s.allowTools) allow.push(`mcp(${name}/${t})`);
      else allow.push(`mcp(${name}/*)`);
    }
    const agentsDir = join(opts.workdir, '.agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'mcp_config.json'), JSON.stringify({ mcpServers }, null, 2) + '\n', { mode: 0o600 });

    if (opts.permissions === 'draft') allow.push(`write_file(${join(opts.workdir, 'drafts')})`);
    const deny = ['command(*)', `write_file(${agentsDir})`, `write_file(${join(opts.workdir, 'AGENTS.md')})`];
    for (const p of opts.denyPaths) deny.push(`read_file(${p})`, `write_file(${p})`);
    if (!opts.webAccess) deny.push('read_url(*)');
    const settingsFile = join(opts.runDir, 'agy-settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify({ toolPermission: 'request-review', permissions: { allow, deny } }, null, 2),
      { mode: 0o600 },
    );

    const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--settings', settingsFile, '--model', opts.model];
    if (opts.reasoning) args.push('--effort', opts.reasoning);
    if (opts.resumeId) args.push('--conversation', opts.resumeId);

    let engineSessionId: string | null = opts.resumeId;
    let announced = false;
    let lastText = '';
    let finalText = '';
    const textByStep = new Map<number, string>();
    const toolSteps = new Set<number>();
    let failure: string | undefined;
    let done = false;
    let usage: Usage | undefined;
    const stepUsage = new Map<number, Usage>();
    const emit = (e: EngineEvent) => opts.onEvent(e);

    const announce = (id: unknown) => {
      if (typeof id !== 'string' || !id || announced) return;
      engineSessionId = id;
      announced = true;
      emit({ kind: 'session', engineSessionId: id });
    };

    const run = await runJsonl({
      command: 'agy',
      args,
      cwd: opts.workdir,
      env,
      stdin: '',
      signal: opts.signal,
      onSpawn: opts.onSpawn,
      onLine(raw) {
        const msg = payload(raw);
        announce(msg.conversation_id);
        switch (raw.event) {
          case 'step_update': {
            const step = Number(msg.step_index);
            // Per-step usage, kept for a run that stops before its result.
            const su = readUsage(msg.usage) ?? readUsage(msg.usage_metadata);
            if (su) stepUsage.set(step, su);
            const state = String(msg.state ?? '').toUpperCase();
            const type = String(msg.step_type ?? '');
            if (type === 'agent_response') {
              if (typeof msg.text_delta === 'string') textByStep.set(step, (textByStep.get(step) ?? '') + msg.text_delta);
              if (state === 'DONE') {
                const text = textByStep.get(step) ?? '';
                textByStep.delete(step);
                if (text.trim()) {
                  lastText = text;
                  emit({ kind: 'text', text });
                }
              }
            } else if (type === 'tool') {
              const callId = `step-${step}`;
              if (!toolSteps.has(step)) {
                toolSteps.add(step);
                // MCP calls arrive wrapped as call_mcp_tool { ServerName, ToolName, Arguments }: report them
                // as mcp__<server>__<tool> like the other engines, so the app and evals recognise them.
                const info = (msg.tool_info ?? {}) as Json;
                const p = (info.parameters ?? {}) as Json;
                const isMcp = msg.tool_name === 'call_mcp_tool' && typeof p.ServerName === 'string' && typeof p.ToolName === 'string';
                emit({
                  kind: 'tool_call',
                  callId,
                  name: isMcp ? `mcp__${p.ServerName}__${p.ToolName}` : String(msg.tool_name ?? 'tool'),
                  input: isMcp ? (p.Arguments ?? {}) : (info.parameters ?? info),
                });
              }
              if (state === 'DONE' || state === 'ERROR' || state === 'FAILED') {
                emit({ kind: 'tool_result', callId, output: truncate(infoText(msg.tool_info)), isError: state !== 'DONE' });
              }
            }
            break;
          }
          case 'result': {
            done = true;
            usage = readUsage(msg.usage) ?? readUsage(msg.usage_metadata) ?? usage;
            const status = String(msg.status ?? '').toUpperCase();
            if (typeof msg.response === 'string') finalText = msg.response;
            if (status && status !== 'SUCCESS') {
              const err = msg.error as Json | string | undefined;
              failure = (typeof err === 'string' ? err : (err?.message as string | undefined)) ?? `Antigravity finished with status ${status}`;
            }
            break;
          }
        }
      },
    });

    const durationMs = Date.now() - started;
    const text = finalText || lastText;
    // No usage on a result (or no result): fall back to what the steps reported.
    if (!usage) for (const u of stepUsage.values()) usage = addUsage(usage, u);
    if (run.aborted) return { ok: false, engineSessionId, finalText: text, error: 'Stopped', durationMs, usage };
    if (!done || failure || run.exitCode !== 0) {
      const error = failure ?? (run.stderrTail || `agy exited with code ${run.exitCode}`);
      const resumeFailed = Boolean(opts.resumeId) && /conversation .*(not found|does not exist)|unknown conversation/i.test(error + run.stderrTail);
      return { ok: false, engineSessionId, finalText: text, error: notSignedInHint(error), resumeFailed, durationMs, usage };
    }
    return { ok: true, engineSessionId, finalText: text, durationMs, usage };
  },
};

function notSignedInHint(error: string): string {
  if (/sign in|signed in|login|authenticat|unauthori[sz]ed|401|credential|keyring/i.test(error)) {
    return `${error}\n\nAntigravity is not signed in. Run: pnpm crew login antigravity`;
  }
  if (/license|plan|subscription|entitle/i.test(error)) {
    return `${error}\n\nThis Google account has no Antigravity plan for this model (Google AI Pro/Ultra, or Gemini Enterprise via "Use Business Account").`;
  }
  return error;
}
