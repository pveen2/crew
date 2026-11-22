// Evals, shaped after eve's: one `*.eval.ts` file per case under evals/, the
// file path is its id. An eval starts a real thread on the running conductor
// (the same API the app uses), waits until it is done and then checks what
// happened.
//
//   export default defineEval({
//     input: 'Welke producten zijn uitverkocht?',
//     async test(t) {
//       t.succeeded();
//       t.delegatedTo('store-manager');
//       await t.judge('Lists the products that are out of stock, or says plainly it could not check.');
//     },
//   });
//
// Assertions are gates by default: a failed gate fails the eval. `soft: true`
// records the result without failing. `t.judge` is soft by default and asks a
// model for a score from 0 to 1. `pnpm crew eval --strict` fails soft checks
// that miss their threshold too.

import type { CrewEvent, ThreadStatus } from '@crew/protocol';
import { kindOf, parseModel, type ModelRef } from './define.ts';

const KIND = Symbol.for('crew.kind');

function tag<T extends object>(kind: string, value: T): T {
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });
  return value;
}

export { kindOf };

export interface CheckOptions {
  /** Record the result without failing the eval. */
  soft?: boolean;
}

export interface JudgeOptions {
  /** Score from 0 to 1 that counts as a pass. Default 0.7. */
  threshold?: number;
  /** Fail the eval when the judge's score is below the threshold. Default false (soft). */
  gate?: boolean;
  /** Override the judge model from evals.config.ts. */
  model?: ModelRef;
}

export interface EvalContext {
  /** The owner's message that started the thread. */
  readonly input: string;
  /** The thread owner's final message. */
  readonly answer: string;
  /** Everything that happened in the thread, in order. */
  readonly events: readonly CrewEvent[];
  readonly status: ThreadStatus;

  /** The thread finished without an error and without waiting for the owner. */
  succeeded(opts?: CheckOptions): void;
  /** Some agent (or the given one) called this tool. Matches MCP names too (`mcp__crew__save_artifact`). */
  calledTool(tool: string, opts?: CheckOptions & { by?: string }): void;
  notCalledTool(tool: string, opts?: CheckOptions & { by?: string }): void;
  /** The lead called this specialist. */
  delegatedTo(agent: string, opts?: CheckOptions): void;
  /** The lead answered without calling any specialist. */
  notDelegated(opts?: CheckOptions): void;
  /** The final answer contains this text (case-insensitive) or matches this pattern. */
  answerMatches(pattern: string | RegExp, opts?: CheckOptions): void;
  /** A custom check. */
  check(name: string, pass: boolean, opts?: CheckOptions & { detail?: string }): void;
  /** Ask a model whether the outcome meets the rubric. Sees the input, the answer, previews and artifacts. */
  judge(rubric: string, opts?: JudgeOptions): Promise<void>;
}

export interface EvalDefinition {
  description?: string;
  /** What the owner types to start the thread. */
  input: string;
  /** Agent that owns the thread. Default: the lead. */
  agent?: string;
  /** Stop waiting after this many minutes. Default from evals.config.ts (15). */
  timeoutMinutes?: number;
  test(t: EvalContext): void | Promise<void>;
}

export function defineEval(def: EvalDefinition): EvalDefinition {
  if (!def.input?.trim()) throw new Error('defineEval: input is required');
  return tag('eval', def);
}

export interface EvalConfig {
  judge?: { model?: ModelRef };
  timeoutMinutes?: number;
  /** Run every eval this many times (the CLI's --repeat wins). */
  repeat?: number;
}

export function defineEvalConfig(def: EvalConfig): EvalConfig {
  if (def.judge?.model) parseModel(def.judge.model);
  return tag('eval-config', def);
}

// ---------------------------------------------------------------------------
// Used by the runner (scripts/eval.ts).

export interface CheckResult {
  name: string;
  pass: boolean;
  gate: boolean;
  score?: number;
  threshold?: number;
  detail?: string;
  /** The judge could not run. Never fails the eval (fail open); shown as skipped. */
  skipped?: boolean;
}

export interface JudgeRequest {
  rubric: string;
  model?: ModelRef;
}

export interface EvalRun {
  input: string;
  answer: string;
  events: CrewEvent[];
  status: ThreadStatus;
  /** session id → agent name */
  agentOf: (sessionId: string) => string;
  lead: string;
  /** Returns a score from 0 to 1 and a reason. */
  judge: (req: JudgeRequest) => Promise<{ score: number; reason: string }>;
}

function toolMatches(name: string, tool: string): boolean {
  return name === tool || name.endsWith(`__${tool}`);
}

export function createContext(run: EvalRun): { t: EvalContext; results: CheckResult[] } {
  const results: CheckResult[] = [];
  const add = (name: string, pass: boolean, opts?: CheckOptions & { detail?: string }) =>
    results.push({ name, pass, gate: !opts?.soft, detail: opts?.detail });

  const toolCalls = (by?: string) =>
    run.events.filter((e): e is Extract<CrewEvent, { type: 'tool_call' }> => e.type === 'tool_call' && (!by || run.agentOf(e.sessionId) === by));
  const leadDelegations = () =>
    run.events.filter(
      (e): e is Extract<CrewEvent, { type: 'subagent_started' }> => e.type === 'subagent_started' && run.agentOf(e.sessionId) === run.lead,
    );

  const t: EvalContext = {
    input: run.input,
    answer: run.answer,
    events: run.events,
    status: run.status,
    succeeded(opts) {
      add('succeeded', run.status === 'idle', { ...opts, detail: `thread status: ${run.status}` });
    },
    calledTool(tool, opts) {
      const calls = toolCalls(opts?.by).map((e) => e.name);
      add(`calledTool(${tool}${opts?.by ? `, by ${opts.by}` : ''})`, calls.some((n) => toolMatches(n, tool)), {
        ...opts,
        detail: calls.length ? `called: ${[...new Set(calls)].join(', ')}` : 'no tool calls',
      });
    },
    notCalledTool(tool, opts) {
      const hit = toolCalls(opts?.by).filter((e) => toolMatches(e.name, tool)).length;
      add(`notCalledTool(${tool}${opts?.by ? `, by ${opts.by}` : ''})`, hit === 0, { ...opts, detail: hit ? `called ${hit}×` : undefined });
    },
    delegatedTo(agent, opts) {
      const roles = leadDelegations().map((e) => e.role);
      add(`delegatedTo(${agent})`, roles.includes(agent), { ...opts, detail: roles.length ? `delegated to: ${roles.join(', ')}` : 'no delegation' });
    },
    notDelegated(opts) {
      const roles = leadDelegations().map((e) => e.role);
      add('notDelegated', roles.length === 0, { ...opts, detail: roles.length ? `delegated to: ${roles.join(', ')}` : undefined });
    },
    answerMatches(pattern, opts) {
      const pass = typeof pattern === 'string' ? run.answer.toLowerCase().includes(pattern.toLowerCase()) : pattern.test(run.answer);
      add(`answerMatches(${String(pattern)})`, pass, opts);
    },
    check(name, pass, opts) {
      add(name, pass, opts);
    },
    async judge(rubric, opts) {
      const threshold = opts?.threshold ?? 0.7;
      const name = `judge: ${rubric.length > 70 ? rubric.slice(0, 69) + '…' : rubric}`;
      try {
        const { score, reason } = await run.judge({ rubric, model: opts?.model });
        results.push({ name, pass: score >= threshold, gate: Boolean(opts?.gate), score, threshold, detail: reason });
      } catch (err) {
        // Fail open like eve's decision helpers: a judge that cannot run says nothing, deterministic checks still count.
        results.push({ name, pass: false, skipped: true, gate: Boolean(opts?.gate), threshold, detail: `judge unavailable: ${(err as Error).message}` });
      }
    },
  };
  return { t, results };
}
