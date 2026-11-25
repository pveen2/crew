import { fileURLToPath } from 'node:url';
import { defineConnection, fromEnv } from '@crew/sdk/define';
import { META_READ_TOOLS } from './tools.ts';

// Read access to Meta ads (Facebook and Instagram) through Meta's hosted Ads
// MCP server: campaigns, performance, creatives, audiences, catalogs, pixels,
// tests. Changes are not part of the connection: they go through the
// meta_ads_change tool (tool.ts), which waits for the owner on every call.
//
// `adAccounts` are the only ad accounts the agent may read or change (ids, with
// or without act_): a token often sees more businesses than the team's own.
//
// The token comes from META_ACCESS_TOKEN in the conductor's environment (the
// app's settings env, or .env.local). It is never written to disk.
export const metaAdsConnection = (opts: { adAccounts: string[]; name?: string }) => {
  if (!opts.adAccounts?.length) throw new Error('metaAdsConnection: list the ad accounts the agent may use in adAccounts');
  return defineConnection({
    description: `${opts.name ? `${opts.name}'s ` : ''}Meta ads (Facebook and Instagram): campaigns, ad sets, ads, performance, creatives, audiences, catalogs, pixels and tests (reading; change with meta_ads_change)`,
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-server.ts', import.meta.url))],
    env: {
      // In the installed Mac app process.execPath is the Crew binary (Electron).
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(process.env.META_ADS_MCP_URL?.trim() ? { META_ADS_MCP_URL: process.env.META_ADS_MCP_URL.trim() } : {}),
      META_AD_ACCOUNTS: opts.adAccounts.join(','),
      META_ACCESS_TOKEN: fromEnv('META_ACCESS_TOKEN'),
    },
    toolTimeoutSec: 120,
    tools: { allow: [...META_READ_TOOLS] },
  });
};
