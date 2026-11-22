import { fileURLToPath } from 'node:url';
import { defineConnection } from '@crew/sdk/define';

// Read access to a Shopify store through the Shopify CLI's stored
// authentication. Defined once here; an agent opts in with a one-line
// connections/shopify.ts, so the allow-list cannot drift between agents.
export const shopifyConnection = (opts: { store: string; name?: string }) =>
  defineConnection({
    description: `${opts.name ?? opts.store} Shopify store (Admin GraphQL API, reading; change things with shopify_mutate)`,
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-server.ts', import.meta.url))],
    env: {
      // In the installed Mac app process.execPath is the Crew binary (Electron).
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      SHOPIFY_STORE: process.env.SHOPIFY_STORE?.trim() || opts.store,
      SHOPIFY_STORE_NAME: opts.name ?? opts.store,
    },
    toolTimeoutSec: 120,
    tools: { allow: ['shopify_query', 'shopify_shop_info'] },
  });
