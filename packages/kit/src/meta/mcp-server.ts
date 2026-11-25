// Read-only Meta Ads MCP server (stdio). Started by the agent CLI through
// connection.ts (metaAdsConnection). It forwards reads to Meta's hosted Ads MCP
// server with the tools' own descriptions and input schemas, and offers only
// the tools in META_READ_TOOLS, inside the ad accounts in CREW_META_AD_ACCOUNTS
// (guard.ts). Changes are not here: they go through the meta_ads_change tool,
// which asks the owner first.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { callMeta, listMetaTools, metaFromEnv } from './client.ts';
import { AccountGuard, allowedAccountsFromEnv } from './guard.ts';
import { META_READ_TOOLS } from './tools.ts';

const READ: ReadonlySet<string> = new Set(META_READ_TOOLS);

function asError(err: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: String((err as Error)?.message ?? err) }] };
}

// Meta's list, filtered, fetched once per session.
let tools: Promise<Tool[]> | undefined;
function readTools(): Promise<Tool[]> {
  tools ??= listMetaTools(metaFromEnv())
    .then((all) =>
      all
        .filter((t) => READ.has(t.name))
        .map((t) => ({ ...t, annotations: { ...t.annotations, readOnlyHint: true, destructiveHint: false, openWorldHint: true } })),
    )
    .catch((err) => {
      tools = undefined;
      throw err;
    });
  return tools;
}

let guard: AccountGuard | undefined;
const accountGuard = () => (guard ??= new AccountGuard(metaFromEnv(), allowedAccountsFromEnv()));

const server = new Server({ name: 'meta-ads', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await readTools() }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!READ.has(name)) return asError(`Refused: ${name} is not a reading tool here. Changes go through meta_ads_change.`);
  try {
    if (name === 'ads_get_ad_accounts') return await accountGuard().listAllowed();
    await accountGuard().check(args ?? {});
    return await callMeta(metaFromEnv(), name, args ?? {});
  } catch (err) {
    return asError(err);
  }
});

await server.connect(new StdioServerTransport());
