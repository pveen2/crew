// Codex adapter, over the app server (JSON-RPC on stdio):
//   codex app-server -c <config>...
//   → initialize, thread/start (or thread/resume <thread id>), turn/start
// The process lives for one turn. While the turn runs, owner messages go in
// with turn/steer; Codex reports a userMessage item with our clientId once the
// agent has read one. The turn ends on turn/completed.
// Crew's own config folder via CODEX_HOME. The app server is marked
// experimental in the CLI, so a Codex update can change this protocol.

import { randomUUID } from 'node:crypto';
import { paths, sharedEngineHome } from '../config.ts';
import { agentBaseEnv, runJsonl, truncate, type StdinHandle } from './process.ts';
import type { EngineAdapter, EngineEvent, EngineResult, EngineRunOptions } from './types.ts';
import type { Usage } from '@crew/protocol';

/** A TOML value. JSON strings and arrays of strings are valid TOML. */
function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')} }`;
  }
  throw new Error(`Cannot write ${typeof value} as TOML`);
}

function mcpResultText(item: Record<string, unknown>): { text: string; isError: boolean } {
  const error = item.error as { message?: string } | null | undefined;
  if (error) return { text: error.message ?? JSON.stringify(error), isError: true };
  const result = item.result as { content?: Array<{ type?: string; text?: string }> } | null | undefined;
  const text = (result?.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
  return { text, isError: item.status === 'failed' };
}

type UserInput = { type: 'text'; text: string; text_elements: [] } | { type: 'localImage'; path: string };

function inputOf(text: string, images: string[] = []): UserInput[] {
  return [{ type: 'text', text, text_elements: [] }, ...images.map((path) => ({ type: 'localImage' as const, path }))];
}

interface RpcError {
  code?: number;
  message?: string;
}

export const codex: EngineAdapter = {
  engine: 'codex',

  loginCommand() {
    return { command: 'codex', args: ['login'], env: { CODEX_HOME: paths.engines.codex } };
  },

  async run(opts: EngineRunOptions): Promise<EngineResult> {
    const started = Date.now();
    const env = agentBaseEnv();
    if (!sharedEngineHome) {
      env.CODEX_HOME = paths.engines.codex;
      // Codex reads ~/.agents/skills regardless of CODEX_HOME: point HOME at an empty folder.
      env.HOME = paths.engines.codexHome;
    }

    const cfg: Array<[string, unknown]> = [
      ['sandbox_mode', opts.permissions === 'draft' ? 'workspace-write' : 'read-only'],
      ['approval_policy', 'never'],
      // Shell commands get only the core variables (PATH, HOME, …), never anything else.
      ['shell_environment_policy.inherit', 'core'],
    ];
    if (!opts.webAccess) cfg.push(['web_search', 'disabled']);
    if (opts.reasoning) cfg.push(['model_reasoning_effort', opts.reasoning]);
    for (const [name, s] of Object.entries(opts.mcpServers)) {
      Object.assign(env, s.secretEnv);
      const key = `mcp_servers.${name}`;
      cfg.push([`${key}.command`, s.command], [`${key}.args`, s.args], [`${key}.env`, s.env]);
      if (Object.keys(s.secretEnv).length) cfg.push([`${key}.env_vars`, Object.keys(s.secretEnv)]);
      cfg.push([`${key}.tool_timeout_sec`, s.toolTimeoutSec], [`${key}.startup_timeout_sec`, 30]);
      if (s.allowTools) cfg.push([`${key}.enabled_tools`, s.allowTools]);
      // With approval_policy=never, anything that needs approval is refused.
      cfg.push([`${key}.default_tools_approval_mode`, s.approve === 'all' ? 'approve' : 'writes']);
    }

    const args = ['app-server'];
    for (const [k, v] of cfg) args.push('-c', `${k}=${toml(v)}`);

    let engineSessionId: string | null = opts.resumeId;
    let lastText = '';
    let failure: string | undefined;
    let lastError: string | undefined;
    let completed = false;
    let resumeFailed = false;
    const emit = (e: EngineEvent) => opts.onEvent(e);

    // JSON-RPC over stdin/stdout.
    let io: StdinHandle | null = null;
    let nextId = 0;
    const calls = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: RpcError) => void }>();
    const request = (method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++nextId;
        calls.set(id, { resolve, reject });
        if (!io?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }))) {
          calls.delete(id);
          reject({ message: 'Codex is not running' });
        }
      });
    const notify = (method: string, params: unknown) => io?.write(JSON.stringify({ jsonrpc: '2.0', method, params }));
    const finish = () => io?.end();

    // Owner messages steered into the turn that the agent has not read yet, by clientUserMessageId.
    const unread = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
    let threadId: string | null = null;
    let activeTurnId: string | null = null;
    const closeSteer = () => {
      if (activeTurnId === null) return;
      activeTurnId = null;
      opts.onSteer?.(null);
    };

    const start = async () => {
      try {
        await request('initialize', {
          clientInfo: { name: 'crew', title: 'Crew', version: '0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        notify('initialized', {});
        const threadParams = { model: opts.model, cwd: opts.workdir };
        let thread: Record<string, unknown>;
        if (opts.resumeId) {
          try {
            thread = await request('thread/resume', { threadId: opts.resumeId, ...threadParams, excludeTurns: true });
          } catch (err) {
            resumeFailed = true;
            throw err;
          }
        } else {
          thread = await request('thread/start', threadParams);
        }
        threadId = String((thread.thread as { id: string }).id);
        engineSessionId = threadId;
        emit({ kind: 'session', engineSessionId });

        const turn = await request('turn/start', { threadId, input: inputOf(opts.prompt, opts.images) });
        const turnId = String((turn.turn as { id: string }).id);
        ourTurnId = turnId;
        if (completed || failure) return;
        activeTurnId = turnId;
        opts.onSteer?.((text, images) => {
          if (activeTurnId !== turnId) return Promise.reject(new Error('The turn has ended'));
          const clientUserMessageId = randomUUID();
          return new Promise<void>((resolve, reject) => {
            unread.set(clientUserMessageId, { resolve, reject });
            request('turn/steer', { threadId, expectedTurnId: turnId, clientUserMessageId, input: inputOf(text, images) }).catch(
              (err: RpcError) => {
                unread.delete(clientUserMessageId);
                reject(new Error(err.message ?? 'Codex did not take the message'));
              },
            );
          });
        });
      } catch (err) {
        failure = (err as RpcError).message ?? String(err);
        finish();
      }
    };

    const usageUpdates: TokenUsageUpdate[] = [];
    let ourTurnId: string | null = null;

    const run = await runJsonl({
      command: 'codex',
      args,
      cwd: opts.workdir,
      env,
      stdin: '',
      keepStdinOpen: true,
      onStdin(handle) {
        io = handle;
        void start();
      },
      signal: opts.signal,
      onSpawn: opts.onSpawn,
      onLine(msg) {
        // A response to one of our requests.
        if (msg.id !== undefined && msg.method === undefined) {
          const call = calls.get(Number(msg.id));
          calls.delete(Number(msg.id));
          if (msg.error) call?.reject(msg.error as RpcError);
          else call?.resolve((msg.result ?? {}) as Record<string, unknown>);
          return;
        }
        // A request from Codex (approvals, elicitations). With approval_policy=never
        // these should not come; refuse anything that does.
        if (msg.id !== undefined) {
          io?.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by Crew' } }));
          return;
        }
        const method = msg.method as string;
        const p = (msg.params ?? {}) as Record<string, unknown>;
        if (method === 'thread/tokenUsage/updated') {
          // Kept until the run ends: a resume replays earlier turns' usage, and this turn's id
          // is known only once turn/start answers.
          const t = p.tokenUsage as TokenUsageUpdate['tokenUsage'] | undefined;
          if (t?.total && t.last) usageUpdates.push({ turnId: String(p.turnId ?? ''), tokenUsage: t });
        } else if (method === 'turn/completed') {
          closeSteer();
          const turn = p.turn as { status?: string; error?: { message?: string } | null };
          if (turn.status === 'completed') completed = true;
          else failure = turn.error?.message ?? (turn.status === 'interrupted' ? 'Codex turn was interrupted' : 'Codex turn failed');
          finish();
        } else if (method === 'error') {
          // Also sent for retries; only fatal if the turn never completes.
          lastError = (p.error as { message?: string })?.message ?? 'Codex error';
        } else if (method === 'item/started' || method === 'item/completed') {
          const item = p.item as Record<string, unknown>;
          const id = String(item.id);
          const done = method === 'item/completed';
          switch (item.type) {
            case 'userMessage': {
              const clientId = item.clientId as string | null;
              if (clientId && unread.has(clientId)) {
                unread.get(clientId)!.resolve();
                unread.delete(clientId);
              }
              break;
            }
            case 'agentMessage':
              if (done && typeof item.text === 'string' && item.text.trim()) {
                lastText = item.text;
                emit({ kind: 'text', text: item.text });
              }
              break;
            case 'reasoning': {
              const text = [...((item.summary as string[]) ?? []), ...((item.content as string[]) ?? [])].join('\n\n');
              if (done && text.trim()) emit({ kind: 'thinking', text });
              break;
            }
            case 'commandExecution':
              if (!done) emit({ kind: 'tool_call', callId: id, name: 'shell', input: { command: item.command } });
              else
                emit({
                  kind: 'tool_result',
                  callId: id,
                  output: truncate(String(item.aggregatedOutput ?? '')),
                  isError: item.status !== 'completed' || (item.exitCode !== 0 && item.exitCode !== null),
                });
              break;
            case 'mcpToolCall':
              if (!done) emit({ kind: 'tool_call', callId: id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments });
              else {
                const r = mcpResultText(item);
                emit({ kind: 'tool_result', callId: id, output: truncate(r.text), isError: r.isError });
              }
              break;
            case 'webSearch':
              if (!done) emit({ kind: 'tool_call', callId: id, name: 'web_search', input: { query: item.query } });
              else emit({ kind: 'tool_result', callId: id, output: '', isError: false });
              break;
            case 'fileChange':
              if (done) {
                emit({ kind: 'tool_call', callId: id, name: 'file_change', input: { changes: item.changes } });
                emit({ kind: 'tool_result', callId: id, output: String(item.status ?? ''), isError: item.status !== 'completed' });
              }
              break;
          }
        }
      },
    });

    closeSteer();
    for (const u of unread.values()) u.reject(new Error('The turn ended before the agent read it'));
    unread.clear();
    for (const c of calls.values()) c.reject({ message: 'Codex exited' });
    calls.clear();

    const durationMs = Date.now() - started;
    const usage = turnUsage(usageUpdates, ourTurnId);
    if (run.aborted) return { ok: false, engineSessionId, finalText: lastText, error: 'Stopped', durationMs, usage };
    if (!completed || failure) {
      const error = failure ?? lastError ?? (run.stderrTail || `codex exited with code ${run.exitCode}`);
      return { ok: false, engineSessionId, finalText: lastText, error: notSignedInHint(error), resumeFailed, durationMs, usage };
    }
    return { ok: true, engineSessionId, finalText: lastText, durationMs, usage };
  },
};

interface TokenUsageUpdate {
  turnId: string;
  tokenUsage: { total: { inputTokens: number; outputTokens: number }; last: { inputTokens: number; outputTokens: number } };
}

/**
 * What this turn used. total covers the whole Codex thread, so take the growth of
 * total across this turn's updates, counting the first update's own call too.
 */
function turnUsage(updates: TokenUsageUpdate[], turnId: string | null): Usage | undefined {
  const ours = turnId ? updates.filter((u) => u.turnId === turnId) : [];
  if (!ours.length) return undefined;
  const first = ours[0]!.tokenUsage;
  const last = ours.at(-1)!.tokenUsage;
  return {
    costUsd: null,
    inputTokens: Math.max(0, last.total.inputTokens - first.total.inputTokens + first.last.inputTokens),
    outputTokens: Math.max(0, last.total.outputTokens - first.total.outputTokens + first.last.outputTokens),
  };
}

function notSignedInHint(error: string): string {
  if (/not logged in|login|401|unauthorized|auth/i.test(error)) {
    return `${error}\n\nCodex is not signed in for Crew. Run: pnpm crew login codex`;
  }
  return error;
}
