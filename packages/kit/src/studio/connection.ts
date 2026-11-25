import { fileURLToPath } from 'node:url';
import { defineConnection, fromEnv } from '@crew/sdk/define';

// Read access to a Studio image workspace over its MCP endpoint. Generating is
// not part of the connection: it spends money, so it is the studio_generate
// tool (tool.ts), which waits for the owner's approval on every call.
//
// The token comes from STUDIO_MCP_TOKEN in the conductor's environment (the
// app's settings env, or .env.local). It is never written to disk.

export const STUDIO_READ_TOOLS = [
  'list_image_models',
  'list_scene_presets',
  'list_reference_photos',
  'list_outputs',
  'list_files',
  'get_output',
  'get_generation',
  'wait_for_generation',
  'look_at_output',
];

export const studioConnection = (opts: { url: string; name?: string }) =>
  defineConnection({
    description: `${opts.name ?? 'Studio'} image workspace: models, scene presets, reference photos, images (generated and uploaded), videos and documents, and job status (reading; generate with studio_generate)`,
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-server.ts', import.meta.url))],
    env: {
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      STUDIO_MCP_URL: process.env.STUDIO_MCP_URL?.trim() || opts.url,
      STUDIO_NAME: opts.name ?? 'Studio',
      STUDIO_MCP_TOKEN: fromEnv('STUDIO_MCP_TOKEN'),
    },
    // wait_for_generation can take a few minutes.
    toolTimeoutSec: 660,
    tools: { allow: STUDIO_READ_TOOLS },
  });
