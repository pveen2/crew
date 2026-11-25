// A small client for Meta's hosted Ads MCP server (https://mcp.facebook.com/ads,
// Streamable HTTP, bearer token). Used by the read-only connection
// (mcp-server.ts) and by the approval-gated meta_ads_change tool (tool.ts).
//
// The token: a user access token, or an Employee-role system user token (Meta
// refuses Admin-role system user tokens), with ads_mcp_management plus ads_read
// (reading) or ads_management (changes). It comes from META_ACCESS_TOKEN in the
// conductor's environment and is never written to disk.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export const META_ADS_MCP_URL = 'https://mcp.facebook.com/ads';

export interface MetaEndpoint {
  url: string;
  token: string;
}

/** The endpoint from the environment: META_ACCESS_TOKEN (and META_ADS_MCP_URL, https only). */
export function metaFromEnv(): MetaEndpoint {
  const url = process.env.META_ADS_MCP_URL?.trim() || META_ADS_MCP_URL;
  const token = process.env.META_ACCESS_TOKEN?.trim() ?? '';
  if (!token) throw new Error('Meta Ads is not set up: add META_ACCESS_TOKEN to the Crew environment (Settings, or .env.local).');
  // The token must never travel in clear text.
  if (new URL(url).protocol !== 'https:') throw new Error('META_ADS_MCP_URL must be https.');
  return { url, token };
}

async function withClient<T>(endpoint: MetaEndpoint, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { authorization: `Bearer ${endpoint.token}` }, redirect: 'error' },
  });
  const client = new Client({ name: 'crew-meta-ads', version: '0.1.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** The tools Meta's server offers this token, with their input schemas. */
export async function listMetaTools(endpoint: MetaEndpoint): Promise<Tool[]> {
  return withClient(endpoint, async (client) => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  });
}

/** Call one tool on Meta's server and return its result as is. Never retries. */
export async function callMeta(endpoint: MetaEndpoint, tool: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return withClient(endpoint, (client) => client.callTool({ name: tool, arguments: args }) as Promise<CallToolResult>);
}
