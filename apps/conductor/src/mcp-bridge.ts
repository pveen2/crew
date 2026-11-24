// The `crew` MCP server. Every CLI starts one per session (stdio). It offers
// the same tools on all engines and forwards Crew's own tools to the
// conductor over local HTTP:
//
//   <subagent>(message)             lead only: one tool per agent/subagents/<name>, e.g. store_manager
//   rename_thread(title)            lead only: give the thread a clearer title
//   ask_owner(question)             put a question in the owner's Inbox
//   show_preview(title, artifactId | content)   show a document to the owner
//   save_artifact(title, content)   specialists: store long work, get an id back
//   read_artifact(id)               read an artifact from this thread
//   <memory>__save_memory(text)     agents with agent/memory/<memory>.ts
//   <memory>__remove_memory(id)
//
// plus the agent's own tools/<name>.ts, executed here in this process after
// the conductor has checked the agent's approval policy.

import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ToolDefinition } from '@crew/sdk/define';
import { resolveTeamImportsFrom } from '@crew/sdk/resolve';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`crew bridge: ${name} is not set`);
  return v;
};

const CONDUCTOR = env('CREW_URL');
const SESSION_ID = env('CREW_SESSION_ID');
const THREAD_ID = env('CREW_THREAD_ID');
const AGENT = env('CREW_AGENT');
const BRIDGE_TOKEN = env('CREW_BRIDGE_TOKEN');
const CAN_SAVE_ARTIFACTS = process.env.CREW_CAN_SAVE_ARTIFACTS === '1';
const CAN_RENAME_THREAD = process.env.CREW_CAN_RENAME_THREAD === '1';
// Team tools may import Crew's packages without their repo installing them.
resolveTeamImportsFrom(import.meta.url);

const TOOL_FILES = JSON.parse(process.env.CREW_TOOL_FILES ?? '[]') as string[];
const SUBAGENTS = JSON.parse(process.env.CREW_SUBAGENTS ?? '[]') as Array<{ tool: string; name: string; label: string; description: string }>;
const MEMORIES = JSON.parse(process.env.CREW_MEMORIES ?? '[]') as Array<{ name: string; description: string }>;

/** POST to the conductor without any client-side timeout: a specialist or an approval may take many minutes. */
function call(tool: string, args: Record<string, unknown>): Promise<string> {
  const body = JSON.stringify({ sessionId: SESSION_ID, tool, args });
  const url = new URL('/internal/tool', CONDUCTOR);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-crew-bridge': BRIDGE_TOKEN,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { text?: string; error?: string };
            if (res.statusCode !== 200 || parsed.error) reject(new Error(parsed.error ?? `conductor returned ${res.statusCode}`));
            else resolve(parsed.text ?? '');
          } catch {
            reject(new Error(`conductor returned ${res.statusCode}: ${data.slice(0, 300)}`));
          }
        });
      },
    );
    req.setTimeout(0);
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * How an HTML document should be written. The app adds Crew's look (packages/ui/src/document.css)
 * and turns attachments/ image paths into the images; keep this in step with that file.
 */
const HTML_GUIDE =
  'HTML documents get the Crew app look automatically: write plain semantic HTML (h1, p.crew-lede, h2, table) ' +
  'with no fonts, colours or page background of your own, unless the owner asked for a specific design or it is a mock-up of an ad or page. ' +
  'Ready-made parts: <div class="crew-grid"> of <div class="crew-card">, each with <div class="crew-card-media"> (4:5) ' +
  'holding an <img> or <span class="crew-placeholder">why there is no image</span>, then <div class="crew-card-body"> with ' +
  '<p class="crew-card-title">, <div class="crew-tags"> of <span class="crew-tag">, <p class="crew-muted"> and ' +
  '<div class="crew-actions"> with <a class="crew-button">. Variants are added next to the base class: ' +
  'crew-card-media--square, crew-card-media--story (9:16), crew-card-media--wide (16:9), crew-card-media--contain (whole screenshot, not cropped); ' +
  'crew-tag--strong, crew-tag--success, crew-tag--caution, crew-tag--critical; crew-button--primary. ' +
  'Example: <div class="crew-card-media crew-card-media--contain">. Also <p class="crew-lede"> under the title, ' +
  '<div class="crew-note"> for a caveat, and <div class="crew-stats"> of <div class="crew-stat"><b>83</b><span>days live</span></div>. ' +
  'Images: use https URLs, or thread images by path: <img src="attachments/<file>">, which covers images the owner attached ' +
  'and screenshots kept with the browser (agent_browser_screenshot with keep: true). No scripts: they do not run.';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (err: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: String((err as Error)?.message ?? err) }] });

/** Forward a Crew tool to the conductor. */
function forward(tool: string) {
  return async (args: Record<string, unknown>) => {
    try {
      return text(await call(tool, args));
    } catch (err) {
      return fail(err);
    }
  };
}

const server = new McpServer({ name: 'crew', version: '0.2.0' });
const local = { readOnlyHint: true, openWorldHint: false };

for (const sub of SUBAGENTS) {
  server.registerTool(
    sub.tool,
    {
      description:
        `Call the ${sub.label}: ${sub.description}\n\n` +
        'They start fresh and see ONLY your message, so make it self-contained: goal, context, constraints, ' +
        'relevant owner preferences, artifact ids from earlier steps, and what to return. Their final message comes back to you.',
      inputSchema: { message: z.string().min(1).describe(`Self-contained brief for the ${sub.label}`) },
      annotations: local,
    },
    forward(sub.tool),
  );
}

if (CAN_RENAME_THREAD) {
  server.registerTool(
    'rename_thread',
    {
      description:
        "Rename this thread in the owner's sidebar. It starts with a short title guessed from the first message; " +
        'rename it when that title is vague or wrong, or when the work turned out to be about something else. ' +
        '3 to 6 words naming the subject, for example "Rhode competitor research". Do not rename just to rephrase a title that already fits.',
      inputSchema: { title: z.string().min(1).max(80) },
      annotations: local,
    },
    forward('rename_thread'),
  );
}

server.registerTool(
  'ask_owner',
  {
    description:
      "Ask the owner a question only they can answer (a decision, missing information, permission). It goes to the owner's Inbox. " +
      'After calling this, end your turn; the answer arrives as a new message.',
    inputSchema: { question: z.string().min(1) },
    annotations: local,
  },
  forward('ask_owner'),
);

server.registerTool(
  'show_preview',
  {
    description:
      "Show a document in the owner's preview panel. Pass artifactId to show an artifact as it is (preferred for anything long), " +
      'or content for something short. Markdown by default; html for layouts and for anything with images (Markdown shows no images). ' +
      'Keep your chat reply short and refer to the preview.\n\n' +
      HTML_GUIDE,
    inputSchema: {
      title: z.string().optional().describe('Defaults to the artifact title'),
      artifactId: z.string().optional(),
      content: z.string().optional(),
      format: z.enum(['markdown', 'html']).optional(),
    },
    annotations: local,
  },
  forward('show_preview'),
);

if (CAN_SAVE_ARTIFACTS) {
  server.registerTool(
    'save_artifact',
    {
      description:
        'Save long work (a draft, table, audit, brief) and get an id back. Return the id with a short summary instead of the full text; ' +
        'the GM shows it to the owner as it is or passes it to a colleague. Markdown by default; html for anything visual or with images ' +
        '(Markdown shows no images).\n\n' +
        HTML_GUIDE,
      inputSchema: {
        title: z.string().min(1),
        content: z.string().min(1),
        format: z.enum(['markdown', 'html']).optional(),
      },
      annotations: local,
    },
    forward('save_artifact'),
  );
}

server.registerTool(
  'read_artifact',
  {
    description: 'Read an artifact from this thread by id (for example one a colleague saved).',
    inputSchema: { id: z.string().min(1) },
    annotations: local,
  },
  forward('read_artifact'),
);

for (const m of MEMORIES) {
  server.registerTool(
    `${m.name}__save_memory`,
    {
      description: `Add one entry to your "${m.name}" memory, kept across threads and shown in your instructions. ${m.description}`,
      inputSchema: { text: z.string().min(1).max(500) },
      annotations: local,
    },
    forward(`${m.name}__save_memory`),
  );
  server.registerTool(
    `${m.name}__remove_memory`,
    {
      description: `Remove an entry from your "${m.name}" memory by its id (the [m_…] in your instructions).`,
      inputSchema: { id: z.string().min(1) },
      annotations: local,
    },
    forward(`${m.name}__remove_memory`),
  );
}

for (const file of TOOL_FILES) {
  const mod = (await import(pathToFileURL(file).href)) as { default: ToolDefinition };
  const def = mod.default;
  const name = basename(file, '.ts');
  server.registerTool(name, { description: def.description, inputSchema: def.inputSchema.shape }, async (input: Record<string, unknown>) => {
    try {
      // The conductor applies the agent's approval policy; it may wait for the owner or refuse.
      await call('approve', { tool: name, input });
      const out = await def.execute(input as never, { agent: AGENT, sessionId: SESSION_ID, threadId: THREAD_ID });
      return text(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    } catch (err) {
      return fail(err);
    }
  });
}

await server.connect(new StdioServerTransport());
