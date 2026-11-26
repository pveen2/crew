// Definition helpers for the Crew team folder, shaped after eve
// (https://eve.dev): every config file default-exports the value returned by a
// define* helper, and names come from file and folder paths.
//
//   agent/agent.ts                     defineAgent: the lead (owns every thread)
//   agent/instructions.md
//   agent/tools/<name>.ts              defineTool (snake_case file name = tool name)
//   agent/skills/<name>/SKILL.md       or skills/<name>.ts → sharedSkill('<name>')
//   agent/connections/<name>.ts        defineConnection (MCP server)
//   agent/memory/<name>.ts             defineMemory
//   agent/subagents/<name>/            same layout, one folder per specialist
//   lib/                               shared factories, rules, brand, shared skills
//   evals/**/<name>.eval.ts            defineEval (see ./evals.ts)
//
// The one difference from eve: `model` names a coding-agent CLI and a model on
// it ('claude-code/opus', 'codex/gpt-6.2-sol@high', 'grok/grok-4.6', 'antigravity/gemini-4-neon-high'), because
// Crew runs every agent on the official CLIs with the owner's subscriptions.
// Folders stay engine-neutral; the conductor translates them.

import type { z } from 'zod';
import type { Engine, Permissions } from '@crew/protocol';

export type { Engine, Permissions };

export type Reasoning = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** `<engine>/<model>[@<reasoning>]`, e.g. 'claude-code/opus' or 'codex/gpt-6.2-sol@high'. */
export type ModelRef = `${Engine}/${string}`;

const KIND = Symbol.for('crew.kind');

function tag<T extends object>(kind: string, value: T): T {
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });
  return value;
}

export function kindOf(value: unknown): string | undefined {
  return value && typeof value === 'object' ? (value as Record<symbol, string>)[KIND] : undefined;
}

const ENGINES: readonly Engine[] = ['claude-code', 'codex', 'grok', 'antigravity'];
const REASONING: readonly Reasoning[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function parseModel(ref: string): { engine: Engine; model: string; reasoning?: Reasoning } {
  const slash = ref.indexOf('/');
  const engine = ref.slice(0, slash) as Engine;
  const [model, reasoning] = ref.slice(slash + 1).split('@');
  if (slash < 0 || !ENGINES.includes(engine) || !model) {
    throw new Error(`model "${ref}" must be <engine>/<model>[@reasoning] with engine ${ENGINES.join(', ')}`);
  }
  if (reasoning !== undefined && !REASONING.includes(reasoning as Reasoning)) {
    throw new Error(`model "${ref}": reasoning must be one of ${REASONING.join(', ')}`);
  }
  return { engine, model, reasoning: reasoning as Reasoning | undefined };
}

// ---------------------------------------------------------------------------
// Approvals. Like eve: a callback per agent that may pause a tool call for the
// owner. Crew tools (built-in and tools/*.ts) go through it. External MCP
// connections cannot be paused mid-call; limit those with `tools.allow`.

export type ApprovalDecision = 'user-approval' | 'deny' | undefined;

export interface ApprovalContext {
  /** Tool name as the agent sees it, e.g. 'preferences__remove_memory' or 'current_time'. */
  toolName: string;
  input: Record<string, unknown>;
  agent: string;
}

// ---------------------------------------------------------------------------
// agent/agent.ts and agent/subagents/<name>/agent.ts

export interface AgentDefinition {
  /** Lead only: its name in threads and the app. Subagents are named by their folder. */
  name?: string;
  /** Display label, e.g. 'Creative strategist'. Defaults to the name in sentence case. */
  label?: string;
  /**
   * One line. Subagents: what the lead sees when deciding whom to call (required).
   * Lead: shown in the app.
   */
  description?: string;
  model: ModelRef;
  /**
   * 'read-only' (default); 'draft': may write files in its own drafts/ folder; 'code': works in its own
   * branch of the team's code repo (CrewConfig.code) with a sandboxed shell, and gets theme_preview,
   * open_pull_request and code_review. Claude Code only.
   */
  permissions?: Permissions;
  /**
   * Web search and fetch. Defaults to on, except for agents with a connection:
   * an agent that can read store or customer data must not be able to send it out.
   */
  webAccess?: boolean;
  /** Pause or refuse a Crew tool call. Return undefined to let the tool's own default apply. */
  approval?: (ctx: ApprovalContext) => ApprovalDecision;
  /** Lead only. */
  limits?: {
    /** A specialist's turn is stopped after this many minutes. Default 20. */
    turnTimeoutMinutes?: number;
    /** A lead turn, including all the work it delegates, is stopped after this many minutes. Default 45. */
    threadTurnTimeoutMinutes?: number;
  };
}

export function defineAgent(def: AgentDefinition): AgentDefinition {
  parseModel(def.model);
  return tag('agent', def);
}

// ---------------------------------------------------------------------------
// tools/<name>.ts: typed functions served to the agent over MCP by the conductor.

export interface ToolContext {
  agent: string;
  sessionId: string;
  threadId: string;
}

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  inputSchema: z.ZodObject<S>;
  /** Default approval when the agent's own `approval` callback returns undefined. */
  approval?: 'user-approval';
  /**
   * The Inbox title for an approval of this call, e.g. what changes and what it
   * costs. Defaults to "<Agent> wants to run <tool>".
   */
  approvalTitle?: (input: z.infer<z.ZodObject<S>>) => string | undefined;
  /**
   * Every call waits for the owner (even without `approval`), even after
   * "approve all in this thread": only allowing this tool itself, from its own
   * card, lets later calls through. For tools that spend money or change
   * things outside Crew. An agent's `approval` callback can still deny the call.
   */
  alwaysAsk?: boolean;
  /**
   * Crew environment variables `execute` reads (tokens, URLs). Tools run in the
   * agent's bridge process, which gets nothing else from the conductor's
   * environment, on every engine.
   */
  env?: string[];
  execute(input: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<unknown> | unknown;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDefinition<S>): ToolDefinition<S> {
  return tag('tool', def);
}

// ---------------------------------------------------------------------------
// connections/<name>.ts: MCP servers. Shared ones are factories in lib/, used
// from a one-line file per agent: `export default shopifyConnection()`.

/** Read a value from the conductor's environment (.env.local) at run time. Never written to disk. */
export interface EnvRef {
  fromEnv: string;
}

export function fromEnv(name: string): EnvRef {
  return { fromEnv: name };
}

export interface StdioConnection {
  description: string;
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string | EnvRef>;
  /** Seconds a single tool call may take. */
  toolTimeoutSec?: number;
  /**
   * Allow-list of the server's tools. A tool the server adds later stays
   * invisible until someone adds it here on purpose.
   */
  tools: { allow: string[] };
}

export type ConnectionDefinition = StdioConnection;

export function defineConnection(def: ConnectionDefinition): ConnectionDefinition {
  if (!def.tools?.allow?.length) throw new Error('defineConnection: list the tools the agent may use in tools.allow');
  return tag('connection', def);
}

// ---------------------------------------------------------------------------
// skills/<name>.ts: use a shared skill from lib/skills/<name>/.

export interface SkillRef {
  shared: string;
}

export function sharedSkill(name: string): SkillRef {
  return tag('skill', { shared: name });
}

// ---------------------------------------------------------------------------
// memory/<name>.ts: a standing document the agent keeps across threads.
// Recalled into the agent's instructions every turn. The agent edits it with
// `<name>__save_memory` and `<name>__remove_memory`.

export interface MemoryDefinition {
  /** What belongs in this memory. Shown to the agent. */
  description: string;
  /** Most entries kept; older ones are dropped first. Default 50. */
  maxEntries?: number;
}

export function defineMemory(def: MemoryDefinition): MemoryDefinition {
  return tag('memory', def);
}

/** One entry of CrewConfig.brand. */
export type BrandSource = string | { from: string; to: string };

/**
 * The team as a whole, from crew.config.ts in the team folder. Everything is
 * optional: a team without the file is named "Crew" and has no store or brand.
 */
export interface CrewConfig {
  /** Shown in the app's sidebar, e.g. the brand the team works for. */
  name?: string;
  /** The Shopify store the team works on. SHOPIFY_STORE overrides it. */
  shopify?: { store: string };
  /** Example questions on the app's New thread screen. */
  suggestions?: string[];
  /** The code repo that agents with permissions 'code' work in, each on its own branch. */
  code?: CodeConfig;
  /**
   * What every session gets read-only in context/brand/. Paths are relative to
   * the team folder and may point outside it, e.g. into the brand's own repo:
   * a folder (its contents are copied), a file, or { from, to } to place a file
   * or folder at `to` inside context/brand/. Default: lib/brand.
   */
  brand?: string | BrandSource[];
  /**
   * The brand's fonts, for drafts the app draws itself (ad concept boards).
   * `file` is relative to the team folder (woff2, woff, otf or ttf). `text` is
   * the default; `accent` sets the words a headline marks with *asterisks*.
   * Without them the app uses its own font.
   */
  fonts?: { text?: FontSource; accent?: FontSource };
}

export interface CodeConfig {
  /** GitHub repo, 'owner/name'. */
  repo: string;
  /** Branch that work starts from and pull requests go into. Default 'main'. */
  base?: string;
  /** Prefix of the agents' branches. Default 'crew/'. */
  branchPrefix?: string;
  /** A Shopify theme in the repo, for theme_preview: its folder, relative to the repo root. */
  theme?: { path: string };
  /** Model for code_review, from another vendor than the developer. Default 'codex/gpt-6.2-sol@high'. */
  reviewer?: ModelRef;
}

export interface FontSource {
  family: string;
  file: string;
  weight?: number;
  style?: 'normal' | 'italic';
}

export function defineCrew(config: CrewConfig): CrewConfig {
  return config;
}
