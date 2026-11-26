import type { Engine, Permissions, Usage } from '@crew/protocol';

/** A stdio MCP server to attach to the CLI. */
export interface McpServerSpec {
  command: string;
  args: string[];
  /** Plain values, safe to write into config. */
  env: Record<string, string>;
  /**
   * Secret values. Passed to the CLI process environment and forwarded to the
   * MCP server by name, so they are never written to disk or command lines.
   */
  secretEnv: Record<string, string>;
  toolTimeoutSec: number;
  /**
   * 'all': every tool is approved (Crew's own bridge).
   * 'read-only': only tools annotated readOnlyHint run; others are refused (external connections).
   */
  approve: 'all' | 'read-only';
  /** Only these tools of the server may be used (the connection's tools.allow). Undefined: all of them. */
  allowTools?: string[];
}

export type EngineEvent =
  | { kind: 'session'; engineSessionId: string }
  | { kind: 'text'; text: string }
  /** A piece of the agent message being written (engines that stream). The finished text still comes as 'text'. */
  | { kind: 'text_delta'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; callId: string; name: string; input: unknown }
  | { kind: 'tool_result'; callId: string; output: string; isError: boolean };

/**
 * Puts an owner message into the turn that is running. Resolves when the agent
 * has read it, rejects when it never will (the turn ended or was stopped first).
 */
export type Steer = (text: string, images?: string[]) => Promise<void>;

export interface EngineRunOptions {
  workdir: string;
  /** Conductor-owned folder for this session's engine config (not visible as agent context). */
  runDir: string;
  model: string;
  reasoning?: string;
  permissions: Permissions;
  prompt: string;
  /** Resume this engine session. */
  resumeId: string | null;
  /** Claude Code only: the id to give a new session, so it is known before the CLI starts. */
  newSessionId?: string;
  mcpServers: Record<string, McpServerSpec>;
  /** Paths the agent must never read or write. */
  denyPaths: string[];
  /** Images for this turn (absolute paths inside the workdir). Engines that take images natively attach them. */
  images?: string[];
  /** A one-off answer with no tools and nothing saved (Crew's own small jobs, like thread titles). Engines do what they support. */
  oneShot?: boolean;
  /** Web search and fetch. Off for roles that can read store or customer data. */
  webAccess: boolean;
  signal: AbortSignal;
  onEvent: (e: EngineEvent) => void;
  onSpawn?: (pid: number) => void;
  /**
   * Engines that can take a message mid-turn call this with a Steer function
   * once they can, and with null as soon as they no longer can.
   */
  onSteer?: (steer: Steer | null) => void;
}

export interface EngineResult {
  ok: boolean;
  engineSessionId: string | null;
  finalText: string;
  error?: string;
  /** True when the CLI could not find the session to resume. */
  resumeFailed?: boolean;
  durationMs: number;
  /** What the run used, when the CLI reports it. */
  usage?: Usage;
}

/** Adds two usages; a cost stays null only when neither side has one. */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/**
 * Reads token counts and a cost from a usage object in whichever naming the CLI
 * uses (input_tokens, inputTokens, prompt_tokens, promptTokenCount, …).
 * Undefined when it holds no counts.
 */
export function readUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const num = (...keys: string[]) => {
    for (const k of keys) if (typeof o[k] === 'number' && Number.isFinite(o[k])) return o[k] as number;
    return undefined;
  };
  const input = num('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'promptTokenCount');
  const cached = num('cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens', 'cachedInputTokens', 'cachedContentTokenCount') ?? 0;
  const created = num('cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheWriteInputTokens') ?? 0;
  const output = num('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'candidatesTokenCount');
  const cost = num('total_cost_usd', 'cost_usd', 'costUsd', 'cost');
  if (input === undefined && output === undefined && cost === undefined) return undefined;
  // Anthropic counts cache reads and writes apart from input_tokens; OpenAI and Google count them inside it.
  const anthropicStyle = 'cache_read_input_tokens' in o || 'cache_creation_input_tokens' in o;
  return {
    costUsd: cost ?? null,
    inputTokens: (input ?? 0) + (anthropicStyle ? cached + created : 0),
    outputTokens: output ?? 0,
  };
}

export interface EngineAdapter {
  engine: Engine;
  run(opts: EngineRunOptions): Promise<EngineResult>;
  /** Command that signs the engine in, using Crew's own config folder. */
  loginCommand(): { command: string; args: string[]; env: Record<string, string> };
}
