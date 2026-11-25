// A thin stdio filter in front of `agent-browser mcp`. It passes every
// JSON-RPC message through unchanged, except:
//
// - Tools: only the ones named in CREW_BROWSER_TOOLS (the connection's
//   allow-list) are listed, and a call to any other is refused here. Claude
//   Code otherwise shows the agent every tool and only denies the call, so an
//   agent kept reaching for agent_browser_eval.
// - Screenshots: the `path` and `screenshotDir` arguments are removed (from the
//   tool's schema and from every call), and a `selector` that looks like a file
//   path is refused: agent-browser saves the image there instead. agent-browser runs with the owner's
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
// - Keeping a page's image or video file: the guard adds its own tool,
//   agent_browser_keep_media(url). It downloads an https image or video (the
//   src the agent read with agent_browser_get_attr) into the same folder, as
//   attachments/media-….jpg or .mp4. That is the creative itself at full size,
//   where a screenshot of a page only shows it as small as the page draws it.
//   Only image and video types are kept, with a size cap, and the connection's
//   allowed domains apply.
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
    'colleagues can open it from their attachments/ folder. To keep an image from a page (an ad creative, a product photo), ' +
    'keep one screenshot per image with selector set to that image, not the whole screen with several items on it.',
};
/** agent-browser's own description says CSS; what works (tested on v0.43.0) is narrower. */
const SELECTOR_SCHEMA = {
  type: 'string',
  description:
    'Capture just this element: an @ref from a snapshot, or a CSS selector that matches it first on the page, ' +
    'e.g. img[alt*="Gymshark"] or a card\'s own class. No "/" (so no XPath): Crew refuses it. ' +
    '">> nth=" and ":nth-match()" are not supported and silently return the whole page. Check the image you get back.',
};
/** The thread's image folder. Unset outside Crew: then nothing can be kept. */
const IMAGES_DIR = process.env.CREW_IMAGES_DIR?.trim() || '';
const MAX_KEEP_BYTES = 10 * 1024 * 1024;
/** The guard's own tool: download an image or video by URL into the thread's image folder. */
const KEEP_MEDIA = 'agent_browser_keep_media';
const KEEP_MEDIA_TOOL = {
  name: KEEP_MEDIA,
  description:
    'Keep an image or video file from a page for the owner, at full size: saved with the thread, and you get back ' +
    'attachments/media-….jpg (or .png, .webp, .gif, .mp4, .webm). Pass the https URL of the file itself: read it with ' +
    'agent_browser_get_attr (an <img> src, a <video> src or poster) and keep it right away, as page links often expire. ' +
    'Show it in an HTML document with <img src="attachments/media-….jpg"> or ' +
    '<video src="attachments/media-….mp4" poster="attachments/media-….jpg" controls muted playsinline>. ' +
    'Better than a screenshot for an ad creative or product photo: the real file, not the page drawing it small.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'https URL of the image or video file' } },
    required: ['url'],
  },
};
const MEDIA_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
/** Videos go into an HTML preview as data: URLs, so keep them modest. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
/** The connection's allowed domains (AGENT_BROWSER_ALLOWED_DOMAINS: `d,*.d,…`). Empty: the open web. */
const ALLOWED_DOMAINS = (process.env.AGENT_BROWSER_ALLOWED_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim().toLowerCase().replace(/^\*\./, ''))
  .filter(Boolean);
/** Where agent-browser saves a screenshot when it is given no path. */
const SHOT_DIR = join(homedir(), '.agent-browser', 'tmp', 'screenshots');

/** The tools the agent may see and call. Unset: all of them (outside Crew). */
const ALLOWED = new Set((process.env.CREW_BROWSER_TOOLS ?? '').split(',').map((t) => t.trim()).filter(Boolean));
const allowed = (name: unknown) => !ALLOWED.size || (typeof name === 'string' && ALLOWED.has(name));

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

/**
 * Keep structuredContent under MAX_CHARS as JSON. Claude Code shows the agent this JSON instead of
 * the text content, and escaped newlines and quotes made a 30,000-character snapshot 55,830 long:
 * over its limit, so the agent got nothing. Shortens the longest string until it fits.
 */
function capStructured(v: unknown): unknown {
  let out = cutDeep(v);
  for (let i = 0; i < 20; i++) {
    const size = JSON.stringify(out).length;
    if (size <= MAX_CHARS) break;
    let longest = '';
    const find = (x: unknown) => {
      if (typeof x === 'string') {
        if (x.length > longest.length) longest = x;
      } else if (x && typeof x === 'object') Object.values(x).forEach(find);
    };
    find(out);
    if (longest.length < 200) break;
    // Escaping can double a string's size, so take off twice the excess (and room for the note).
    const keep = Math.max(0, longest.length - 2 * (size - MAX_CHARS) - 400);
    const shorter =
      longest.slice(0, keep) +
      `\n\n[Cut by Crew: ${longest.length.toLocaleString('en')} characters, first ${keep.toLocaleString('en')} shown. ` +
      'Use filter, outline, or a screenshot to get at the rest.]';
    const swap = (x: unknown): unknown => {
      if (x === longest) return shorter;
      if (Array.isArray(x)) return x.map(swap);
      if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, swap(y)]));
      return x;
    };
    out = swap(out);
  }
  return out;
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

/** Save bytes in the thread's image folder under a fresh name: written as a dot file, then renamed. */
function saveKept(prefix: string, ext: string, data: Buffer): string {
  const name = `${prefix}-${randomBytes(4).toString('hex')}.${ext}`;
  mkdirSync(IMAGES_DIR, { recursive: true, mode: 0o700 });
  const part = join(IMAGES_DIR, `.${name}.part`);
  writeFileSync(part, data, { mode: 0o600, flag: 'wx' });
  renameSync(part, join(IMAGES_DIR, name));
  return name;
}

/** Download an image or video by URL into the thread's image folder. Returns the note for the agent. */
async function keepMedia(raw: unknown): Promise<string> {
  if (!IMAGES_DIR) return 'Not kept: this browser is not running inside a Crew thread.';
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return 'Not kept: pass the full https URL of the image or video file.';
  }
  if (url.protocol !== 'https:') return 'Not kept: only https URLs.';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) {
    return 'Not kept: use the file\'s web address, not a local or numeric one.';
  }
  if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return `Not kept: ${host} is outside this browser's allowed domains.`;
  }
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) return `Not kept: the server answered ${res.status}. Page links expire: read the src again and keep it right away.`;
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = MEDIA_TYPES[type];
  if (!ext) {
    await res.body?.cancel();
    return `Not kept: that link is ${type || 'of an unknown type'}, not an image or video file.`;
  }
  const tooBig = `Not kept: the file is larger than ${MAX_MEDIA_BYTES / 1024 / 1024} MB. Keep its poster image instead.`;
  if (Number(res.headers.get('content-length')) > MAX_MEDIA_BYTES) {
    await res.body?.cancel();
    return tooBig;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_MEDIA_BYTES) return tooBig;
    chunks.push(Buffer.from(chunk));
  }
  if (!size) return 'Not kept: the file came back empty.';
  const name = saveKept('media', ext, Buffer.concat(chunks));
  return type.startsWith('video/')
    ? `Kept as attachments/${name}. Show it with <video src="attachments/${name}" poster="attachments/<a kept image>" controls muted playsinline>.`
    : `Kept as attachments/${name}. Show it with <img src="attachments/${name}" alt="…">.`;
}

/** The guard's own tool: answer it here, never reach agent-browser. */
function ownTool(msg: Msg): boolean {
  if (msg.method !== 'tools/call' || msg.params?.name !== KEEP_MEDIA) return false;
  const reply = (text: string, isError: boolean) => {
    if (msg.id === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError, content: [{ type: 'text', text }] } }) + '\n');
  };
  keepMedia(msg.params?.arguments?.url).then(
    (text) => reply(text, !text.startsWith('Kept as')),
    (err) => reply(`Not kept: ${(err as Error).message}`, true),
  );
  return true;
}

/**
 * agent-browser's MCP takes a screenshot selector that looks like a file ("a/b", "x.png") as the
 * output path and writes the image there, with the owner's rights (tested on v0.43.0).
 */
const PATH_LIKE = /[\\/~]|\.(?:png|jpe?g|webp)\s*$/i;

/** Why this call must not reach agent-browser, or '' when it may. */
function refusal(msg: Msg): string {
  if (msg.method !== 'tools/call') return '';
  const name = msg.params?.name;
  if (!allowed(name)) {
    return (
      `${String(name)} is not available in Crew. ` +
      "To show the owner a page's images, use agent_browser_screenshot with keep: true and a selector for each image."
    );
  }
  const selector = msg.params?.arguments?.selector;
  if (name === SCREENSHOT && typeof selector === 'string' && PATH_LIKE.test(selector)) {
    return 'Refused by Crew: a selector with "/", "\\", "~" or an image file ending is taken as a file path. Use an @ref or a CSS selector.';
  }
  return '';
}

/** A call Crew does not allow: answer it here, never reach agent-browser. */
function refuse(msg: Msg): boolean {
  const text = refusal(msg);
  if (!text) return false;
  if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text }] } }) + '\n');
  }
  return true;
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
    if (Array.isArray(msg.result.tools)) {
      msg.result.tools = msg.result.tools.filter((t: any) => allowed(t?.name));
      if (allowed(KEEP_MEDIA)) msg.result.tools.push(KEEP_MEDIA_TOOL);
    }
    for (const tool of msg.result.tools ?? []) {
      if (tool.name !== SCREENSHOT) continue;
      for (const a of PATH_ARGS) delete tool.inputSchema?.properties?.[a];
      if (tool.inputSchema?.properties) {
        tool.inputSchema.properties[KEEP] = KEEP_SCHEMA;
        if (tool.inputSchema.properties.selector) tool.inputSchema.properties.selector = SELECTOR_SCHEMA;
      }
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
      // Claude Code shows the agent structuredContent instead of the text, so the note goes there too, first.
      if (msg.result.structuredContent && typeof msg.result.structuredContent === 'object') {
        msg.result.structuredContent = { crew: note, ...msg.result.structuredContent };
      }
    }
    for (const c of msg.result.content ?? []) {
      if (c?.type === 'text' && typeof c.text === 'string') c.text = cut(c.text);
    }
    if (msg.result.structuredContent) msg.result.structuredContent = capStructured(msg.result.structuredContent);
  }
  return msg;
}

function pipe(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, fn: (m: Msg) => Msg | null) {
  createInterface({ input, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    let out = line;
    try {
      const msg = fn(JSON.parse(line));
      if (!msg) return;
      out = JSON.stringify(msg);
    } catch {
      // Not JSON: pass it through as is.
    }
    output.write(out + '\n');
  });
}

pipe(process.stdin, child.stdin!, (m) => (refuse(m) || ownTool(m) ? null : fromClient(m)));
pipe(child.stdout!, process.stdout, fromServer);
process.stdin.on('end', () => child.stdin!.end());
