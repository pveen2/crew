// Minimal read-only Shopify Admin GraphQL MCP server (stdio).
// Started by Claude Code or Codex through connection.ts (shopifyConnection).
//
// The query guard and Shopify CLI both enforce read-only access here. Changes
// go through the store manager's shopify_mutate tool, which asks the owner.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { graphql, isReadOnlyQuery } from './cli.ts';

function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function asError(err: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: String((err as Error)?.message ?? err) }] };
}

const store = process.env.SHOPIFY_STORE?.trim() ?? '';
const storeName = process.env.SHOPIFY_STORE_NAME?.trim() || store;

const server = new McpServer({ name: 'shopify', version: '0.1.0' });

server.registerTool(
  'shopify_query',
  {
    description:
      `Run a read-only GraphQL query against the ${storeName} Shopify Admin API. Mutations are refused here; use shopify_mutate for changes. ` +
      'Uses the Shopify CLI default API version. Keep queries small: request only the fields you need and use first: 20-50.',
    inputSchema: {
      query: z.string().describe('GraphQL query (no mutations)'),
      variables: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, variables }) => {
    if (!isReadOnlyQuery(query)) return asError('Refused: this tool only reads. Use shopify_mutate for changes.');
    try {
      return asText(await graphql(store, query, variables));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  'shopify_shop_info',
  { description: `Basic facts about the ${storeName} store: name, domain, currency, plan, country.`, inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => {
    try {
      return asText(
        await graphql(
          store,
          `{ shop { name myshopifyDomain primaryDomain { url } currencyCode plan { displayName } billingAddress { countryCodeV2 } } }`,
        ),
      );
    } catch (err) {
      return asError(err);
    }
  },
);

await server.connect(new StdioServerTransport());
