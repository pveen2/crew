import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@crew/sdk/define';
import { callStudio, studioFromEnv } from './client.ts';

// Puts finished files into a Studio workspace's assets, so each gets a public
// CDN link another agent or tool can use (Meta ads take images and videos by
// URL, not as files; a PDF or a self-contained HTML page can be shared by
// link, and Studio runs HTML sandboxed). Uploads come from the agent's own session folder only:
// drafts/ (what it made) and attachments/ (what the owner attached in the
// thread). No approval: it costs nothing, but every link is public, so only
// final work goes up, and every call makes new links.

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const VIDEO_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
const DOCUMENT_TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.html': 'text/html', '.htm': 'text/html' };
type Kind = 'image' | 'video' | 'document';

function kindOf(ext: string): { kind: Kind; contentType: string } | null {
  if (IMAGE_TYPES[ext]) return { kind: 'image', contentType: IMAGE_TYPES[ext] };
  if (VIDEO_TYPES[ext]) return { kind: 'video', contentType: VIDEO_TYPES[ext] };
  if (DOCUMENT_TYPES[ext]) return { kind: 'document', contentType: DOCUMENT_TYPES[ext] };
  return null;
}
/** Studio's MCP takes at most 8 MiB per file; bigger videos go up in Studio itself. */
const MAX_BYTES = 8 * 1024 * 1024;
const FOLDERS = ['drafts', 'attachments'];

/**
 * A file in the session's drafts/ or attachments/. Both must be real folders in
 * the session folder (an agent that can write could swap one for a link to
 * somewhere else), and the file, links followed, must be inside one of them.
 */
function sessionFile(rel: string): string {
  const cwd = process.cwd();
  if (!existsSync(join(cwd, 'AGENTS.md'))) throw new Error('studio_upload only runs in an agent session.');
  const root = realpathSync(cwd);
  const target = join(root, rel);
  const real = existsSync(target) ? realpathSync(target) : null;
  for (const folder of FOLDERS) {
    const base = join(root, folder);
    const st = lstatSync(base, { throwIfNoEntry: false });
    if (!st?.isDirectory()) continue; // missing, or a link: never trusted
    if (real && real.startsWith(base + sep) && statSync(real).isFile()) return real;
  }
  throw new Error(`${rel}: not a file in drafts/ or attachments/.`);
}

interface Uploaded {
  file: string;
  kind: Kind;
  id?: string;
  url?: string;
}

function pick(result: unknown, key: 'output' | 'file'): { id?: string; url?: string } {
  const v = (result as Record<string, { id?: unknown; url?: unknown } | undefined>)?.[key];
  return { id: typeof v?.id === 'string' ? v.id : undefined, url: typeof v?.url === 'string' ? v.url : undefined };
}

export const studioUploadTool = (opts: { url: string; name?: string }) => {
  const studio = opts.name ?? 'Studio';
  return defineTool({
    description:
      `Upload final files to ${studio} and get a public CDN link for each: images (PNG, JPG, WebP, GIF), short videos (MP4, MOV, WebM) ` +
      'and documents (PDF, or a self-contained HTML page: everything inline, Studio runs it sandboxed), up to 8 MB each. ' +
      'For example for a Meta ad, or to share a report by link. Files from your drafts/ or the owner\'s attachments/ only. ' +
      'Every call makes new public links: upload only what is final, once. To update a video or document you uploaded before and keep its link, ' +
      'pass one file and its id as replace (same file type). Never call again after an error before checking the assets in Studio.',
    inputSchema: z.object({
      files: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(10)
        .describe('Paths in your session folder, e.g. "drafts/exports/winter/winter-4x5.png", "attachments/photo.jpg" or "drafts/report.html".'),
      replace: z
        .string()
        .uuid()
        .optional()
        .describe('Only with one video or document: the id of a file uploaded before, to update it at its existing link. Images cannot be replaced.'),
    }),
    env: ['STUDIO_MCP_TOKEN', 'STUDIO_MCP_URL'],
    async execute({ files, replace }) {
      // Check every file before the first upload, so a bad path uploads nothing.
      const checked = files.map((rel) => {
        const path = sessionFile(rel);
        const type = kindOf(extname(path).toLowerCase());
        if (!type) throw new Error(`${rel}: only images (png, jpg, webp, gif), videos (mp4, mov, webm) and documents (pdf, html).`);
        const size = statSync(path).size;
        if (!size) throw new Error(`${rel} is empty.`);
        if (size > MAX_BYTES) throw new Error(`${rel} is over 8 MB: upload it in ${studio} itself.`);
        return { rel, path, ...type };
      });
      if (replace && (checked.length !== 1 || checked[0]!.kind === 'image')) {
        throw new Error('replace works for one video or document at a time; images always get a new link.');
      }

      const endpoint = studioFromEnv(opts.url);
      const uploaded: Uploaded[] = [];
      for (const f of checked) {
        const args = { filename: basename(f.path), contentType: f.contentType, data: readFileSync(f.path).toString('base64'), ...(replace ? { replace } : {}) };
        try {
          const result = await callStudio(endpoint, f.kind === 'image' ? 'upload_image' : 'upload_file', args);
          uploaded.push({ file: f.rel, kind: f.kind, ...pick(result, f.kind === 'image' ? 'output' : 'file') });
        } catch (err) {
          const done = uploaded.length ? ` Already uploaded: ${uploaded.map((u) => `${u.file} → ${u.url}`).join(', ')}.` : '';
          throw new Error(`${f.rel}: ${(err as Error).message}${done}`);
        }
      }
      return { uploaded };
    },
  });
};
