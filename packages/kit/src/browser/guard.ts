// A thin stdio filter in front of `agent-browser mcp`. It passes every
// JSON-RPC message through unchanged, except:
//
// - Screenshots: the `path` and `screenshotDir` arguments are removed (from the
//   tool's schema and from every call). agent-browser runs with the owner's
//   real HOME, so a chosen path could overwrite any of the owner's files.
//   The image still comes back inline, which is what the agent needs.
//   agent-browser also keeps its own copy under ~/.agent-browser/tmp/screenshots
//   and names it in the result: that copy is deleted and its path left out.
// - Keeping a screenshot: the guard adds a `keep` argument. With keep: true
//   the image is also saved, under a name the guard picks, in the thread's
//   image folder (CREW_IMAGES_DIR, set by the conductor). The agent gets back
//   `attachments/shot-….png`: colleagues find it in their attachments/ folder
//   and an HTML document can show it with <img src="attachments/shot-….png">.
//   This is how a page's images (an ad creative, a product photo) reach the
//   owner without the agent ever choosing where a file goes.
// - Browser sessions: every session name gets the Crew session as a suffix
//   (CREW_BROWSER_SCOPE), so threads never share a tab.
// - Results: any text longer than MAX_CHARS is cut, with a note. config.json's
//   maxOutput does not cover `agent_browser_read` with `raw: true` (a Pinterest
//   page came back at 1.3M characters). Claude Code then saves the overflow
//   under its own config folder, which Crew does not let agents read, so the
//   agent lost the whole result. Image data is never cut.
//
// Usage: guard.ts <agent-browser args...>

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

// Text and structuredContent can carry the same page, and Claude Code stops at about 25,000 tokens.
const MAX_CHARS = 30_000;
const SCREENSHOT = 'agent_browser_screenshot';
const PATH_ARGS = ['path', 'screenshotDir'];
const KEEP = 'keep';
const KEEP_SCHEMA = {
  type: 'boolean',
  default: false,
  description:
    'Keep this image for the owner: it is saved with the thread and you get back a path like attachments/shot-1a2b3c.png. ' +
    'Put that path in an HTML document (<img src="attachments/shot-1a2b3c.png">) to show the image in the preview; ' +
    'colleagues can open it from their attachments/ folder. Pass selector (an @ref or CSS selector) to keep just one element, ' +
    'such as an ad creative or a product photo, instead of the whole screen.',
};
/** The thread's image folder. Unset outside Crew: then nothing can be kept. */
const IMAGES_DIR = process.env.CREW_IMAGES_DIR?.trim() || '';
const MAX_KEEP_BYTES = 10 * 1024 * 1024;
/** Where agent-browser saves a screenshot when it is given no path. */
const SHOT_DIR = join(homedir(), '.agent-browser', 'tmp', 'screenshots');

type Msg = { id?: unknown; method?: string; params?: any; result?: any };
type Kind = 'list' | 'call' | 'shot' | 'keep';

/**
 * The Crew session this browser serves (set by the conductor). Every browser session name gets it as
 * a suffix, so two threads (or two runs of one agent) never share a tab: a screenshot kept for one
 * thread can never show a page another thread just opened.
 */
const SCOPE = (process.env.CREW_BROWSER_SCOPE ?? '').replace(/[^\p{L}\p{N}_-]/gu, '');
const scoped = (name: string) => (SCOPE ? `${name}-${SCOPE}` : name);

const child = spawn('agent-browser', process.argv.slice(2), {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ...(process.env.AGENT_BROWSER_SESSION ? { AGENT_BROWSER_SESSION: scoped(process.env.AGENT_BROWSER_SESSION) } : {}) },
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => {
  process.stderr.write(`crew browser guard: could not start agent-browser: ${err.message}\n`);
  process.exit(1);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));

/** Request ids we sent as tools/list or tools/call, so we know what each response is. */
const pending = new Map<string, Kind>();
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

/** Delete agent-browser's temp copy of a screenshot and leave its path out of the result. Returns the copies, read before deleting. */
function dropShotCopies(msg: Msg, beforeDelete?: (files: string[]) => void): void {
  const found = new Set<string>();
  const scan = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(/\S+\.(?:png|jpe?g|webp)\b/gi, (p) => {
        const abs = resolve(p);
        if (!abs.startsWith(SHOT_DIR + sep)) return p;
        found.add(abs);
        return '(screenshot attached)';
      });
    }
    if (Array.isArray(v)) return v.map(scan);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'data' ? x : scan(x)]));
    return v;
  };
  msg.result = scan(msg.result);
  beforeDelete?.([...found]);
  for (const f of found) rmSync(f, { force: true });
}

/** Save a kept screenshot in the thread's image folder. Returns the note for the agent. */
function keepShot(msg: Msg, files: string[]): string {
  if (!IMAGES_DIR) return 'Not kept: this browser is not running inside a Crew thread.';
  const image = (msg.result?.content ?? []).find((c: any) => c?.type === 'image' && typeof c.data === 'string');
  const file = files.find((f) => existsSync(f) && statSync(f).size > 0);
  const ext = (file ? file.split('.').pop() : image?.mimeType === 'image/jpeg' ? 'jpg' : 'png')?.toLowerCase().replace('jpeg', 'jpg') ?? 'png';
  if (!['png', 'jpg', 'webp'].includes(ext)) return 'Not kept: unexpected image type.';
  const size = file ? statSync(file).size : image ? Buffer.byteLength(image.data, 'base64') : 0;
  if (!size) return 'Not kept: the screenshot came back without an image.';
  if (size > MAX_KEEP_BYTES) return 'Not kept: the image is larger than 10 MB. Capture one element with selector, or use format jpeg.';
  const name = `shot-${randomBytes(4).toString('hex')}.${ext}`;
  mkdirSync(IMAGES_DIR, { recursive: true, mode: 0o700 });
  // Written under a dot name, then renamed: the conductor copies the folder to other agents at
  // any moment and skips dot files, so nobody ever gets half an image.
  const part = join(IMAGES_DIR, `.${name}.part`);
  if (file) {
    copyFileSync(file, part, constants.COPYFILE_EXCL);
    chmodSync(part, 0o600);
  } else writeFileSync(part, Buffer.from(image.data, 'base64'), { mode: 0o600, flag: 'wx' });
  renameSync(part, join(IMAGES_DIR, name));
  return `Kept as attachments/${name}. Show it in an HTML document with <img src="attachments/${name}" alt="…">.`;
}

function fromClient(msg: Msg): Msg {
  const isShot = msg.method === 'tools/call' && msg.params?.name === SCREENSHOT;
  const keep = isShot && msg.params.arguments?.[KEEP] === true;
  if (msg.id !== undefined && (msg.method === 'tools/list' || msg.method === 'tools/call')) {
    pending.set(key(msg.id), msg.method === 'tools/list' ? 'list' : keep ? 'keep' : isShot ? 'shot' : 'call');
  }
  if (msg.method === 'tools/call' && typeof msg.params?.arguments?.session === 'string' && msg.params.arguments.session) {
    msg.params.arguments.session = scoped(msg.params.arguments.session);
  }
  if (isShot && msg.params.arguments) {
    for (const a of [...PATH_ARGS, KEEP]) delete msg.params.arguments[a];
    // A kept image must come back whole, never skipped as "unchanged".
    if (keep) for (const a of ['ifChanged', 'threshold']) delete msg.params.arguments[a];
  }
  return msg;
}

function fromServer(msg: Msg): Msg {
  if (msg.id === undefined) return msg;
  const kind = pending.get(key(msg.id));
  if (!kind) return msg;
  pending.delete(key(msg.id));
  if (!msg.result) return msg;
  if (kind === 'list') {
    for (const tool of msg.result.tools ?? []) {
      if (tool.name !== SCREENSHOT) continue;
      for (const a of PATH_ARGS) delete tool.inputSchema?.properties?.[a];
      if (tool.inputSchema?.properties) tool.inputSchema.properties[KEEP] = KEEP_SCHEMA;
      if (Array.isArray(tool.inputSchema?.required)) {
        tool.inputSchema.required = tool.inputSchema.required.filter((r: string) => !PATH_ARGS.includes(r));
      }
    }
  } else {
    if (kind === 'shot') dropShotCopies(msg);
    // A failed screenshot already says why; there is nothing to keep.
    if (kind === 'keep' && !msg.result.isError) {
      let note = '';
      dropShotCopies(msg, (files) => {
        try {
          note = keepShot(msg, files);
        } catch (err) {
          note = `Not kept: ${(err as Error).message}`;
        }
      });
      (msg.result.content ??= []).push({ type: 'text', text: note });
    }
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
