// A thin stdio filter in front of `agent-browser mcp`. It passes every
// JSON-RPC message through unchanged, except:
//
// - Screenshots: the `path` and `screenshotDir` arguments are removed (from the
//   tool's schema and from every call). agent-browser runs with the owner's
//   real HOME, so a chosen path could overwrite any of the owner's files.
//   The image still comes back inline, which is what the agent needs.
// - Results: any text longer than MAX_CHARS is cut, with a note. config.json's
//   maxOutput does not cover `agent_browser_read` with `raw: true` (a Pinterest
//   page came back at 1.3M characters). Claude Code then saves the overflow
//   under its own config folder, which Crew does not let agents read, so the
//   agent lost the whole result. Image data is never cut.
//
// Usage: guard.ts <agent-browser args...>

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Text and structuredContent can carry the same page, and Claude Code stops at about 25,000 tokens.
const MAX_CHARS = 30_000;
const SCREENSHOT = 'agent_browser_screenshot';
const PATH_ARGS = ['path', 'screenshotDir'];

type Msg = { id?: unknown; method?: string; params?: any; result?: any };

const child = spawn('agent-browser', process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => {
  process.stderr.write(`crew browser guard: could not start agent-browser: ${err.message}\n`);
  process.exit(1);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));

/** Request ids we sent as tools/list or tools/call, so we know what each response is. */
const pending = new Map<string, 'list' | 'call'>();
const key = (id: unknown) => JSON.stringify(id);

function cut(s: string): string {
  if (s.length <= MAX_CHARS) return s;
  return (
    s.slice(0, MAX_CHARS) +
    `\n\n[Cut by Crew: ${s.length.toLocaleString('en')} characters, first ${MAX_CHARS.toLocaleString('en')} shown. ` +
    'Use filter, outline, or a screenshot to get at the rest.]'
  );
}

/** Cut long strings anywhere in a JSON value. */
function cutDeep(v: unknown): unknown {
  if (typeof v === 'string') return cut(v);
  if (Array.isArray(v)) return v.map(cutDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutDeep(x)]));
  return v;
}

function fromClient(msg: Msg): Msg {
  if (msg.id !== undefined && (msg.method === 'tools/list' || msg.method === 'tools/call')) {
    pending.set(key(msg.id), msg.method === 'tools/list' ? 'list' : 'call');
  }
  if (msg.method === 'tools/call' && msg.params?.name === SCREENSHOT && msg.params.arguments) {
    for (const a of PATH_ARGS) delete msg.params.arguments[a];
  }
  return msg;
}

function fromServer(msg: Msg): Msg {
  if (msg.id === undefined || !msg.result) return msg;
  const kind = pending.get(key(msg.id));
  if (!kind) return msg;
  pending.delete(key(msg.id));
  if (kind === 'list') {
    for (const tool of msg.result.tools ?? []) {
      if (tool.name !== SCREENSHOT) continue;
      for (const a of PATH_ARGS) delete tool.inputSchema?.properties?.[a];
      if (Array.isArray(tool.inputSchema?.required)) {
        tool.inputSchema.required = tool.inputSchema.required.filter((r: string) => !PATH_ARGS.includes(r));
      }
    }
  } else {
    for (const c of msg.result.content ?? []) {
      if (c?.type === 'text' && typeof c.text === 'string') c.text = cut(c.text);
    }
    if (msg.result.structuredContent) msg.result.structuredContent = cutDeep(msg.result.structuredContent);
  }
  return msg;
}

function pipe(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, fn: (m: Msg) => Msg) {
  createInterface({ input, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    let out = line;
    try {
      out = JSON.stringify(fn(JSON.parse(line)));
    } catch {
      // Not JSON: pass it through as is.
    }
    output.write(out + '\n');
  });
}

pipe(process.stdin, child.stdin!, fromClient);
pipe(child.stdout!, process.stdout, fromServer);
process.stdin.on('end', () => child.stdin!.end());
