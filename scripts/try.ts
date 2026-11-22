// pnpm crew try <agent> "<prompt>" --models claude-code/opus,claude-code/sonnet,codex/gpt-6.2-sol@high [--attach <image or folder>]
//
// Runs the prompt through one agent on several models in parallel (each in its
// own folder, same translation, no colleagues), then writes one HTML page
// with the answers side by side plus the time per model, and opens it.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { marked } from 'marked';
import type { Engine } from '@crew/protocol';
import { parseModel } from '@crew/sdk/define';
import { loadCrew } from '@crew/sdk/load';
import { denyPaths, paths, REAL_HOME } from '@crew/conductor/config';
import { engines, type McpServerSpec } from '@crew/conductor/engines';
import { translateAgent } from '@crew/conductor/translate';

interface Variant {
  label: string;
  engine: Engine;
  model: string;
  reasoning?: string;
}

interface Outcome extends Variant {
  ok: boolean;
  text: string;
  error?: string;
  durationMs: number;
  toolCalls: number;
}

export function parseModels(spec: string): Variant[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // Same form as an agent's model: engine/model[@reasoning], e.g. codex/gpt-6.2-sol@high.
      // The older engine:model form and the short engine name 'claude' still work.
      const ref = s.replace(/^claude([:/])/, 'claude-code$1').replace(/^([a-z-]+):/, '$1/');
      try {
        const { engine, model, reasoning } = parseModel(ref);
        return { label: s, engine, model, reasoning };
      } catch {
        throw new Error(`Bad model "${s}". Use engine/model, e.g. claude-code/opus, codex/gpt-6.2-sol@high or grok/grok-4.6`);
      }
    });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function html(role: string, prompt: string, results: Outcome[]): string {
  const fastest = Math.min(...results.filter((r) => r.ok).map((r) => r.durationMs));
  const cols = results
    .map(
      (r) => `
    <section class="col">
      <header>
        <div class="model">${esc(r.model)}${r.reasoning ? ` <span class="chip">${esc(r.reasoning)}</span>` : ''}</div>
        <div class="meta">
          <span class="chip">${esc(r.engine)}</span>
          <span class="chip ${r.durationMs === fastest ? 'best' : ''}">${fmt(r.durationMs)}</span>
          <span class="chip">${r.toolCalls} tool call${r.toolCalls === 1 ? '' : 's'}</span>
          <span class="chip">${r.text.split(/\s+/).filter(Boolean).length} words</span>
          ${r.ok ? '' : '<span class="chip err">failed</span>'}
        </div>
      </header>
      <article>${r.ok ? marked.parse(r.text) : `<pre class="err">${esc(r.error ?? 'Unknown error')}</pre>${r.text ? marked.parse(r.text) : ''}`}</article>
    </section>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>crew try · ${esc(role)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f5f2; --card:#fff; --ink:#1d1c1a; --mute:#77736b; --line:#e7e4de; --accent:#e8692a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161513; --card:#201f1c; --ink:#f1efe9; --mute:#9a958b; --line:#33312c; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif; background:var(--bg); color:var(--ink); }
  .top { padding:28px 32px 8px; }
  .top h1 { font-size:20px; margin:0 0 6px; }
  .top .prompt { color:var(--mute); white-space:pre-wrap; max-width:1100px; }
  .grid { display:grid; grid-template-columns:repeat(${results.length}, minmax(340px, 1fr)); gap:16px; padding:20px 32px 40px; overflow-x:auto; }
  .col { background:var(--card); border:1px solid var(--line); border-radius:14px; overflow:hidden; display:flex; flex-direction:column; }
  .col header { padding:14px 18px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--card); }
  .model { font-weight:600; font-size:15px; margin-bottom:6px; }
  .meta { display:flex; gap:6px; flex-wrap:wrap; }
  .chip { font-size:12px; padding:2px 8px; border-radius:99px; background:var(--bg); color:var(--mute); border:1px solid var(--line); }
  .chip.best { color:#fff; background:var(--accent); border-color:var(--accent); }
  .chip.err { color:#fff; background:#c0392b; border-color:#c0392b; }
  article { padding:6px 18px 18px; overflow-wrap:anywhere; }
  article table { border-collapse:collapse; width:100%; font-size:13px; }
  article th, article td { border:1px solid var(--line); padding:4px 6px; text-align:left; vertical-align:top; }
  pre { white-space:pre-wrap; background:var(--bg); padding:10px; border-radius:8px; font-size:12px; }
  pre.err { color:#c0392b; }
</style></head><body>
<div class="top"><h1>crew try · ${esc(role)}</h1><div class="prompt">${esc(prompt)}</div></div>
<div class="grid">${cols}</div>
</body></html>`;
}

const IMAGE = /^\.(png|jpe?g|gif|webp)$/i;

/** Image files from --attach: comma-separated files and/or folders (their images, sorted). */
export function attachmentFiles(spec: string | undefined): string[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => resolve(s.trim()))
    .filter(Boolean)
    .flatMap((p) => {
      if (!existsSync(p)) throw new Error(`--attach: ${p} does not exist`);
      if (statSync(p).isDirectory()) return readdirSync(p).filter((f) => IMAGE.test(extname(f))).sort().map((f) => join(p, f));
      if (!IMAGE.test(extname(p))) throw new Error(`--attach: ${p} is not an image (png, jpg, gif, webp)`);
      return [p];
    });
}

export async function runTry(opts: { role: string; prompt: string; models: string; attach?: string; open?: boolean }): Promise<string> {
  const crew = await loadCrew();
  const role = crew.agents[opts.role];
  if (!role) throw new Error(`Usage: pnpm crew try <agent> "<prompt>" --models claude-code/opus,codex/gpt-6.2-sol. Agents: ${Object.keys(crew.agents).join(', ')}`);
  if (!opts.prompt.trim()) throw new Error('The prompt is empty.');
  const variants = parseModels(opts.models || role.def.model);
  const images = attachmentFiles(opts.attach);
  // Same note the app adds when the owner attaches images.
  const prompt = images.length
    ? `${opts.prompt}\n\n[The owner attached ${images.length === 1 ? 'an image' : `${images.length} images`}: ` +
      images.map((f) => `attachments/${basename(f)}`).join(', ') +
      '. They are in your attachments/ folder; look at them before you answer.]'
    : opts.prompt;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(paths.try, `${stamp}-${role.name}`);
  mkdirSync(outDir, { recursive: true });

  console.log(`Running ${role.label} on ${variants.length} model(s) in parallel${images.length ? ` with ${images.length} image(s)` : ''}…`);
  const results = await Promise.all(
    variants.map(async (v, i): Promise<Outcome> => {
      const workdir = join(outDir, `${i + 1}-${v.engine}-${v.model}`.replace(/[^\w.-]/g, '_'));
      translateAgent({ crew, agent: role, engine: v.engine, workdir, canDelegate: false, comparison: true });
      if (images.length) {
        mkdirSync(join(workdir, 'attachments'), { recursive: true });
        for (const f of images) copyFileSync(f, join(workdir, 'attachments', basename(f)));
      }

      const mcpServers: Record<string, McpServerSpec> = {};
      for (const [name, c] of Object.entries(role.connections)) {
        const env: Record<string, string> = {};
        const secretEnv: Record<string, string> = {};
        for (const [k, val] of Object.entries(c.env ?? {})) {
          if (typeof val === 'string') env[k] = val;
          else if (process.env[val.fromEnv]) secretEnv[k] = process.env[val.fromEnv]!;
        }
        env.HOME = REAL_HOME;
        mcpServers[name] = {
          command: c.command,
          args: c.args ?? [],
          env,
          secretEnv,
          toolTimeoutSec: c.toolTimeoutSec ?? 120,
          approve: 'read-only',
          allowTools: c.tools.allow,
        };
      }

      let toolCalls = 0;
      const r = await engines[v.engine].run({
        workdir,
        runDir: join(workdir, '..', `.run-${i + 1}`),
        model: v.model,
        reasoning: v.reasoning ?? (v.engine === role.engine ? role.reasoning : undefined),
        permissions: role.permissions,
        prompt,
        images: images.map((f) => join(workdir, 'attachments', basename(f))),
        resumeId: null,
        newSessionId: v.engine === 'claude-code' || v.engine === 'grok' ? randomUUID() : undefined,
        mcpServers,
        denyPaths: denyPaths(),
        webAccess: role.webAccess,
        signal: AbortSignal.timeout(crew.limits.turnTimeoutMinutes * 60_000),
        onEvent: (e) => {
          if (e.kind === 'tool_call') toolCalls++;
        },
      });
      console.log(`  ${r.ok ? '✓' : '✗'} ${v.label.padEnd(28)} ${fmt(r.durationMs)}${r.ok ? '' : `  ${r.error?.split('\n')[0]}`}`);
      return { ...v, ok: r.ok, text: r.finalText, error: r.error, durationMs: r.durationMs, toolCalls };
    }),
  );

  const file = join(outDir, 'index.html');
  writeFileSync(file, html(role.label, opts.prompt, results));
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ role: role.name, prompt: opts.prompt, results }, null, 2));
  console.log(`\n${file}`);
  if (opts.open !== false && process.platform === 'darwin') spawn('open', [file], { stdio: 'ignore', detached: true }).unref();
  return file;
}

// Allow running directly: node scripts/try.ts <role> "<prompt>" --models ...
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--models');
  const models = i >= 0 ? args.splice(i, 2)[1]! : '';
  const a = args.indexOf('--attach');
  const attach = a >= 0 ? args.splice(a, 2)[1] : undefined;
  const noOpen = args.includes('--no-open');
  const [role, ...rest] = args.filter((a) => a !== '--no-open');
  runTry({ role: role ?? '', prompt: rest.join(' '), models, attach, open: !noOpen }).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
