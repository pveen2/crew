// A small client for Wakey-style Studio MCP endpoints (Streamable HTTP, bearer
// token, stateless). Used by the read-only connection (mcp-server.ts) and by the
// approval-gated generate tool (tool.ts).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface StudioEndpoint {
  /** Full MCP URL, ending in /mcp. */
  url: string;
  /** Bearer token. */
  token: string;
}

/** The endpoint from the environment: STUDIO_MCP_URL and STUDIO_MCP_TOKEN. */
export function studioFromEnv(fallbackUrl?: string): StudioEndpoint {
  const url = process.env.STUDIO_MCP_URL?.trim() || fallbackUrl || '';
  const token = process.env.STUDIO_MCP_TOKEN?.trim() ?? '';
  if (!url) throw new Error('Studio is not set up: STUDIO_MCP_URL is missing.');
  if (!token) throw new Error('Studio is not set up: add STUDIO_MCP_TOKEN to the Crew environment (Settings, or .env.local).');
  const u = new URL(url);
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  // The token must never travel in clear text to another machine.
  if (u.protocol !== 'https:' && !(loopback && u.protocol === 'http:')) throw new Error('STUDIO_MCP_URL must be https (or http on localhost).');
  return { url, token };
}

/** Call one Studio tool and return its structured result. Never retries. */
export async function callStudio(endpoint: StudioEndpoint, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { authorization: `Bearer ${endpoint.token}` }, redirect: 'error' },
  });
  const client = new Client({ name: 'crew-studio', version: '0.1.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = Array.isArray(res.content)
      ? res.content.filter((c): c is { type: 'text'; text: string } => c?.type === 'text').map((c) => c.text).join('\n')
      : '';
    if (res.isError) throw new Error(text || `Studio ${tool} failed`);
    if (res.structuredContent) return res.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    await client.close().catch(() => {});
  }
}
