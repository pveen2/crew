// Read-only Google Search Console MCP server (stdio). Started by the agent CLI
// through connection.ts (searchConsoleConnection) for one property
// (CREW_GSC_SITE), signed in as a service account (GOOGLE_SEARCH_CONSOLE_KEY).
// The tools themselves are in server.ts.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KEY_VAR } from './auth.ts';
import { createSearchConsoleServer } from './server.ts';

const site = process.env.CREW_GSC_SITE?.trim();
if (!site) {
  console.error('search-console: CREW_GSC_SITE is not set (searchConsoleConnection sets it).');
  process.exit(1);
}

const server = createSearchConsoleServer({ site, readKey: () => process.env[KEY_VAR] });
await server.connect(new StdioServerTransport());
