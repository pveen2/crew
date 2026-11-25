// Meta ads for Crew teams, through Meta's hosted Ads MCP server: a read-only
// connection for agents, plus meta_ads_change for changes the owner approves.

export { metaAdsConnection } from './connection.ts';
export { metaAdsChangeTool } from './tool.ts';
export { META_READ_TOOLS, META_WRITE_TOOLS, META_SPEND_TOOLS, metaChangeSpends } from './tools.ts';
export { resolveAdAccounts, type MetaAdAccounts } from './accounts.ts';
export { AccountGuard, allowedAccountsFromEnv } from './guard.ts';
export { callMeta, listMetaTools, metaFromEnv, META_ADS_MCP_URL, type MetaEndpoint } from './client.ts';
