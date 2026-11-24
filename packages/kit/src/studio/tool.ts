import { z } from 'zod';
import { defineTool } from '@crew/sdk/define';
import { callStudio, studioFromEnv } from './client.ts';

// Starts one image generation in Studio. It costs money, so every call waits in
// the owner's Inbox; the owner sees the summary, the prompt and the settings.
// It never retries: a retry after an unclear failure can start (and pay for) a
// second job. Wait for the result with the connection's wait_for_generation.
export const studioGenerateTool = (opts: { url: string; name?: string }) =>
  defineTool({
    description:
      `Generate images in ${opts.name ?? 'Studio'} (costs money; every call waits for the owner's approval). Returns a generation id: ` +
      'then call wait_for_generation. Never call this again for the same image after an error or timeout: check list_outputs first.',
    inputSchema: z.object({
      summary: z
        .string()
        .min(10)
        .describe('For the owner, in plain words: what this image is for and what it shows. Example: "Ad 1, Before Coffee Cools: four packshots and a coffee mug on sand, 4:5".'),
      prompt: z
        .string()
        .min(1)
        .max(8000)
        .describe('The full image prompt: subject, composition, light, background, camera. Studio has no separate camera or background fields.'),
      outputCount: z.number().int().min(1).max(4).optional().describe('Variants, 1 to 4. Default 1. Each one costs.'),
      aspectRatio: z.enum(['4:5', '1:1', '9:16', '16:9']).optional(),
      scenePresetId: z.string().max(200).optional().describe('From list_scene_presets.'),
      imageModel: z.string().max(200).optional().describe('From list_image_models. Leave out for the default.'),
      referenceIds: z.array(z.string().min(1).max(200)).max(8).optional().describe('Up to 8 ids from list_reference_photos (e.g. the real packshots).'),
    }),
    approval: 'user-approval',
    async execute({ summary: _summary, ...args }) {
      const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      return callStudio(studioFromEnv(opts.url), 'generate', { outputCount: 1, ...clean });
    },
  });
