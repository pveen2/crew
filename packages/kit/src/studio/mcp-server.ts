// Read-only Studio MCP server (stdio). Started by the agent CLI through
// connection.ts (studioConnection). It forwards reads to the remote Studio MCP
// and adds wait_for_generation. Generating images is not here: that spends
// money and goes through the studio_generate tool, which asks the owner first.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callStudio, studioFromEnv } from './client.ts';

const name = process.env.STUDIO_NAME?.trim() || 'Studio';

function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}
function asError(err: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: String((err as Error)?.message ?? err) }] };
}
async function forward(tool: string, args: Record<string, unknown> = {}) {
  try {
    return asText(await callStudio(studioFromEnv(), tool, args));
  } catch (err) {
    return asError(err);
  }
}

const server = new McpServer({ name: 'studio', version: '0.1.0' });
const read = { readOnlyHint: true, openWorldHint: true };

server.registerTool(
  'list_image_models',
  { description: `Image models ${name} can generate with now, and the default. Check this before choosing imageModel.`, inputSchema: {}, annotations: read },
  () => forward('list_image_models'),
);
server.registerTool(
  'list_scene_presets',
  { description: `${name}'s scene presets (ids for scenePresetId when generating).`, inputSchema: {}, annotations: read },
  () => forward('list_scene_presets'),
);
server.registerTool(
  'list_reference_photos',
  { description: `Reference photos in ${name} (packshots, products, models), with the ids to pass as referenceIds when generating.`, inputSchema: {}, annotations: read },
  () => forward('list_reference_photos'),
);
server.registerTool(
  'list_outputs',
  {
    description: `Recent images in ${name}, newest first, with their public CDN URLs.`,
    inputSchema: { limit: z.number().int().min(1).max(40).optional() },
    annotations: read,
  },
  ({ limit }) => forward('list_outputs', limit ? { limit } : {}),
);
server.registerTool(
  'get_output',
  { description: `One image in ${name} by output id.`, inputSchema: { outputId: z.string().min(1).max(200) }, annotations: read },
  ({ outputId }) => forward('get_output', { outputId }),
);
server.registerTool(
  'get_generation',
  { description: `A generation job by id: its status (queued, running, complete, failed) and its images.`, inputSchema: { generationId: z.string().min(1).max(200) }, annotations: read },
  ({ generationId }) => forward('get_generation', { generationId }),
);
server.registerTool(
  'wait_for_generation',
  {
    description: 'Wait until a generation job is complete or failed (checks every 5 seconds), then return it. Use this after studio_generate instead of polling yourself.',
    inputSchema: { generationId: z.string().min(1).max(200), timeoutSec: z.number().int().min(10).max(600).optional() },
    annotations: read,
  },
  async ({ generationId, timeoutSec }) => {
    const until = Date.now() + (timeoutSec ?? 300) * 1000;
    try {
      const endpoint = studioFromEnv();
      for (;;) {
        const res = (await callStudio(endpoint, 'get_generation', { generationId })) as { generation?: { status?: string } };
        const status = res?.generation?.status;
        if (status === 'complete' || status === 'failed') return asText(res);
        if (Date.now() > until) return asText({ ...res, note: `Still ${status ?? 'running'} after ${timeoutSec ?? 300}s. Call wait_for_generation again; do not generate again.` });
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (err) {
      return asError(err);
    }
  },
);

// Lets the agent see an image before it hands it over (packaging, text, product
// fidelity). Only URLs Studio itself returns for an output, never an arbitrary one.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
server.registerTool(
  'look_at_output',
  {
    description: 'See one Studio image (by output id) to check it: product and packaging fidelity, text, hands, artefacts. Use it on every image before you hand it over.',
    inputSchema: { outputId: z.string().min(1).max(200) },
    annotations: read,
  },
  async ({ outputId }) => {
    try {
      const res = (await callStudio(studioFromEnv(), 'get_output', { outputId })) as { output?: { url?: string; ready?: boolean } | null };
      const out = res?.output;
      if (!out) return asError(`No image ${outputId} (missing or rejected).`);
      if (!out.ready || !out.url) return asError(`Image ${outputId} is not ready yet.`);
      const url = new URL(out.url);
      if (url.protocol !== 'https:') return asError('Studio returned a non-https image URL.');
      // A smaller rendition is enough to judge the image, where the CDN supports it.
      const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!r.ok) return asError(`Could not load ${out.url}: HTTP ${r.status}`);
      const mime = (r.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) return asError(`${out.url} is ${mime || 'not an image'}; open it in a browser to check it.`);
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) return asError(`${out.url} is ${(bytes.length / 1048576).toFixed(1)} MB, too large to view here.`);
      return {
        content: [
          { type: 'image' as const, data: bytes.toString('base64'), mimeType: mime },
          { type: 'text' as const, text: JSON.stringify({ outputId, url: out.url }) },
        ],
      };
    } catch (err) {
      return asError(err);
    }
  },
);

await server.connect(new StdioServerTransport());
