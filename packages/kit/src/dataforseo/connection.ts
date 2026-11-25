import { fileURLToPath } from 'node:url';
import { defineConnection, fromEnv } from '@crew/sdk/define';

/** The tools an agent gets: all six read. */
export const DATAFORSEO_TOOLS = [
  'seo_google_serp',
  'seo_search_volume',
  'seo_keyword_ideas',
  'seo_ranked_keywords',
  'seo_competitors',
  'seo_page_audit',
] as const;

// Search data from DataForSEO (https://dataforseo.com): live Google results,
// keyword volumes and ideas, the searches a domain ranks for, its competitors,
// and on-page checks. Reading only, so no tool waits for the owner.
//
// `location` and `language` are the defaults for every call ("Netherlands",
// "en"); an agent can ask for another country or language per call.
// `maxCostPerSession` caps what one agent session spends, in USD (default 2).
//
// The sign-in comes from DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD (the API
// login and password from app.dataforseo.com → API Access) in the conductor's
// environment (the app's settings env, or .env.local). Never written to disk.
export const dataForSeoConnection = (opts: { location?: string; language?: string; maxCostPerSession?: number } = {}) =>
  defineConnection({
    description: `Search data from DataForSEO: live Google results, keyword volumes and ideas, a domain's rankings and competitors, on-page checks (default ${opts.location ?? 'Netherlands'}, ${opts.language ?? 'en'}; costs cents per call)`,
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-server.ts', import.meta.url))],
    env: {
      // In the installed Mac app process.execPath is the Crew binary (Electron).
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(opts.location ? { CREW_DATAFORSEO_LOCATION: opts.location } : {}),
      ...(opts.language ? { CREW_DATAFORSEO_LANGUAGE: opts.language } : {}),
      ...(opts.maxCostPerSession ? { CREW_DATAFORSEO_MAX_COST: String(opts.maxCostPerSession) } : {}),
      DATAFORSEO_LOGIN: fromEnv('DATAFORSEO_LOGIN'),
      DATAFORSEO_PASSWORD: fromEnv('DATAFORSEO_PASSWORD'),
    },
    toolTimeoutSec: 120,
    tools: { allow: [...DATAFORSEO_TOOLS] },
  });
