// The app as a web page, for phones: on a team server the conductor serves the
// built renderer (apps/mac/dist) on its own origin, so a browser signed in
// through Cloudflare Access reaches the API and WebSocket with Access's cookie
// and no app token. Only behind Access (see server.ts); a conductor on a Mac
// has the Mac app.

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

/** CREW_WEB_DIR overrides where the built app is (default: this checkout's apps/mac/dist). */
const ROOT = normalize(process.env.CREW_WEB_DIR?.trim() || fileURLToPath(new URL('../../mac/dist/', import.meta.url)));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Served without an Access login (Cloudflare Access bypasses them too): the home screen icon and manifest. */
export const PUBLIC_WEB_FILES = new Set(['/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest']);

async function file(path: string): Promise<Buffer | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Serves a GET for the web app. Unknown paths get index.html (the app routes
 * with #hashes, so this only matters for a mistyped link). False when the app
 * is not built, or (with fallback: false) when the file is missing.
 */
export async function serveWeb(pathname: string, res: ServerResponse, opts: { fallback?: boolean } = {}): Promise<boolean> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  } catch {
    rel = 'index.html';
  }
  const full = normalize(join(ROOT, rel));
  const inside = full.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep);
  let body = inside ? await file(full) : null;
  let path = full;
  if (!body) {
    if (opts.fallback === false) return false;
    path = join(ROOT, 'index.html');
    body = await file(path);
    if (!body) return false;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    // Vite puts a content hash in every asset name; everything else is checked each time.
    'cache-control': rel.startsWith('assets/') && path === full ? 'private, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
  return true;
}
