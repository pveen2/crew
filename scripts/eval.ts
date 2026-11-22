// pnpm crew eval [filter] [--repeat n] [--strict] [--keep]
//
// Runs packages/crew/evals/**/*.eval.ts against the running conductor: each
// eval starts a real thread (same API as the app), waits until it is done and
// runs its checks. The judge is one more CLI run on the owner's subscriptions.
// Results go to ~/.crew/evals/<time>.json. Exit code 1 when a gate fails (or,
// with --strict, a soft check misses its threshold).

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CrewEvent, Thread, ThreadDetailResponse } from '@crew/protocol';
import { parseModel, type ModelRef } from '@crew/sdk/define';
import { createContext, kindOf, type CheckResult, type EvalConfig, type EvalDefinition } from '@crew/sdk/evals';
import { TEAM_ROOT, listEvalFiles, loadCrew } from '@crew/sdk/load';
import { denyPaths, paths } from '@crew/conductor/config';
import { engines } from '@crew/conductor/engines';
import { api, bold, dim, fmtDuration, green, red, yellow } from './api.ts';

const DEFAULT_JUDGE: ModelRef = 'claude-code/sonnet';

interface EvalOutcome {
  id: string;
  run: number;
  threadId: string;
  status: string;
  durationMs: number;
  results: CheckResult[];
  passed: boolean;
}

async function importDefault<T>(file: string): Promise<T> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: T };
  if (mod.default === undefined) throw new Error(`${file} must have a default export`);
  return mod.default;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForThread(threadId: string, timeoutMs: number): Promise<{ detail: ThreadDetailResponse; timedOut: boolean }> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const detail = await api<ThreadDetailResponse>('GET', `/api/threads/${threadId}`);
    if (detail.thread.status !== 'running') return { detail, timedOut: false };
    if (Date.now() > until) {
      await api('POST', `/api/sessions/${detail.thread.rootSessionId}/stop`);
      await sleep(2000);
      return { detail: await api<ThreadDetailResponse>('GET', `/api/threads/${threadId}`), timedOut: true };
    }
    await sleep(2000);
  }
}

function judgeMaterial(input: string, answer: string, events: CrewEvent[]): string {
  const previews = events
    .filter((e): e is Extract<CrewEvent, { type: 'preview' }> => e.type === 'preview')
    .map((p) => `### Preview: ${p.title}\n\n${p.content.length > 20_000 ? p.content.slice(0, 20_000) + '\n…(cut)' : p.content}`);
  return [
    "## The owner's request",
    '',
    input,
    '',
    "## The team's final answer",
    '',
    answer || '(no answer)',
    '',
    ...(previews.length ? ['## Documents shown to the owner', '', ...previews] : []),
  ].join('\n');
}

async function judge(ref: ModelRef, rubric: string, material: string): Promise<{ score: number; reason: string }> {
  const { engine, model, reasoning } = parseModel(ref);
  const base = join(paths.home, 'evals', 'judge');
  mkdirSync(base, { recursive: true });
  const workdir = mkdtempSync(join(base, 'run-'));
  const prompt = [
    'You grade the work of an AI team for a small Dutch brand. Be strict and fair; judge only what is in front of you.',
    `Today is ${new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'full' })}.`,
    '',
    `Rubric: ${rubric}`,
    '',
    material,
    '',
    'Reply with only one JSON object and nothing else: {"score": <number from 0 to 1>, "reason": "<one or two sentences>"}',
  ].join('\n');
  const r = await engines[engine].run({
    workdir,
    runDir: join(workdir, '.run'),
    model,
    reasoning,
    permissions: 'read-only',
    prompt,
    resumeId: null,
    newSessionId: engine === 'claude-code' || engine === 'grok' ? randomUUID() : undefined,
    mcpServers: {},
    denyPaths: denyPaths(),
    webAccess: false,
    signal: AbortSignal.timeout(5 * 60_000),
    onEvent: () => {},
  });
  if (!r.ok) throw new Error(r.error?.split('\n')[0] ?? 'judge failed');
  const json = r.finalText.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error('judge gave no JSON');
  const parsed = JSON.parse(json) as { score?: unknown; reason?: unknown };
  const score = Number(parsed.score);
  if (!Number.isFinite(score)) throw new Error('judge gave no score');
  return { score: Math.max(0, Math.min(1, score)), reason: String(parsed.reason ?? '') };
}

export async function runEvals(opts: { filter?: string; repeat?: number; strict?: boolean; keep?: boolean }): Promise<number> {
  const crew = await loadCrew();
  const files = listEvalFiles().filter((f) => !opts.filter || f.id.includes(opts.filter));
  if (!files.length) {
    console.log(yellow(`No evals${opts.filter ? ` matching "${opts.filter}"` : ''} in packages/crew/evals/.`));
    return 1;
  }
  const configFile = join(TEAM_ROOT, 'evals', 'evals.config.ts');
  const config: EvalConfig = existsSync(configFile) ? await importDefault<EvalConfig>(configFile) : {};
  if (existsSync(configFile) && kindOf(config) !== 'eval-config') throw new Error('evals/evals.config.ts: export default defineEvalConfig({...})');
  const repeat = opts.repeat ?? config.repeat ?? 1;
  const judgeModel = config.judge?.model ?? DEFAULT_JUDGE;

  console.log(bold(`Running ${files.length} eval(s)${repeat > 1 ? ` × ${repeat}` : ''} · judge ${judgeModel}\n`));
  const outcomes: EvalOutcome[] = [];

  for (const { id, file } of files) {
    const def = await importDefault<EvalDefinition>(file);
    if (kindOf(def) !== 'eval') throw new Error(`${file}: export default defineEval({...})`);
    const timeoutMs = (def.timeoutMinutes ?? config.timeoutMinutes ?? 15) * 60_000;

    for (let run = 1; run <= repeat; run++) {
      const started = Date.now();
      const thread = await api<Thread>('POST', '/api/threads', { text: def.input, role: def.agent });
      const { detail, timedOut } = await waitForThread(thread.id, timeoutMs);
      const agentOf = new Map(detail.sessions.map((s) => [s.id, s.role]));
      const rootTurns = detail.turns.filter((t) => t.sessionId === detail.thread.rootSessionId);
      const answer = rootTurns.at(-1)?.result ?? '';

      const { t, results } = createContext({
        input: def.input,
        answer,
        events: detail.events,
        status: detail.thread.status,
        agentOf: (sid) => agentOf.get(sid) ?? '?',
        lead: def.agent ?? crew.lead,
        judge: ({ rubric, model }) => judge(model ?? judgeModel, rubric, judgeMaterial(def.input, answer, detail.events)),
      });
      if (timedOut) t.check('finished in time', false, { detail: `stopped after ${fmtDuration(timeoutMs)}` });
      try {
        await def.test(t);
      } catch (err) {
        t.check('test ran', false, { detail: (err as Error).message });
      }
      if (!opts.keep) await api('POST', `/api/threads/${thread.id}/archive`).catch(() => {});

      const failsGate = results.some((r) => r.gate && !r.pass && !r.skipped);
      const failsSoft = results.some((r) => !r.gate && !r.pass && !r.skipped);
      const passed = !failsGate && !(opts.strict && failsSoft);
      const durationMs = Date.now() - started;
      outcomes.push({ id, run, threadId: thread.id, status: detail.thread.status, durationMs, results, passed });

      const label = repeat > 1 ? `${id} #${run}` : id;
      console.log(`${passed ? green('✓') : red('✗')} ${bold(label)} ${dim(`${fmtDuration(durationMs)} · thread ${thread.id}`)}`);
      for (const r of results) {
        const mark = r.skipped ? yellow('–') : r.pass ? green('✓') : r.gate ? red('✗') : yellow('!');
        const score = r.score !== undefined ? ` ${r.score.toFixed(2)}/${r.threshold}` : '';
        const show = !r.pass || r.score !== undefined;
        console.log(`    ${mark} ${r.name}${score}${r.gate ? '' : dim(' (soft)')}${show && r.detail ? dim(` · ${r.detail}`) : ''}`);
      }
    }
  }

  const passedCount = outcomes.filter((o) => o.passed).length;
  const dir = join(paths.home, 'evals');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(file, JSON.stringify({ judge: judgeModel, strict: Boolean(opts.strict), outcomes }, null, 2));
  console.log(`\n${passedCount === outcomes.length ? green('All passed') : red(`${outcomes.length - passedCount} failed`)} · ${passedCount}/${outcomes.length} · ${dim(file)}`);
  return passedCount === outcomes.length ? 0 : 1;
}
