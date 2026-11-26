import { fileURLToPath } from 'node:url';
import { defineConnection, fromEnv } from '@crew/sdk/define';
import { KEY_VAR } from './auth.ts';
import { normalizeSite } from './client.ts';
import { SEARCH_CONSOLE_TOOLS } from './tools.ts';

export { SEARCH_CONSOLE_TOOLS };

// Google Search Console for one property, reading only: search performance
// (queries, pages, countries, devices, dates), URL inspection and sitemaps.
// No tool waits for the owner.
//
// `site` is the property exactly as Search Console names it:
// 'sc-domain:wakey.care' (a domain property) or 'https://wakey.care/' (a URL
// prefix). The agent can only query that property.
//
// Signed in as a Google Cloud service account: its JSON key (as it is, or
// base64 of it) in GOOGLE_SEARCH_CONSOLE_KEY in the conductor's environment
// (the app's settings env, or .env.local). Never written to disk. The service
// account must be added as a user of the property (see .env.example).
export const searchConsoleConnection = (opts: { site: string }) => {
  const site = normalizeSite(opts.site);
  return defineConnection({
    description: `Google Search Console for ${site}: clicks, impressions, CTR and position by query, page, country, device and date; URL inspection (indexing, canonical); sitemaps. Data lags about 2-3 days`,
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-server.ts', import.meta.url))],
    env: {
      // In the installed Mac app process.execPath is the Crew binary (Electron).
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      CREW_GSC_SITE: site,
      [KEY_VAR]: fromEnv(KEY_VAR),
    },
    toolTimeoutSec: 120,
    tools: { allow: [...SEARCH_CONSOLE_TOOLS] },
  });
};
