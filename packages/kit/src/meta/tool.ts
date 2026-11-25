import { z } from 'zod';
import { defineTool } from '@crew/sdk/define';
import { callMeta, metaFromEnv } from './client.ts';
import { AccountGuard } from './guard.ts';
import { META_SPEND_TOOLS, META_WRITE_TOOLS } from './tools.ts';

// The only way a Crew agent changes anything in Meta ads. Every call waits in
// the owner's Inbox; the owner sees the summary, the Meta tool and its
// arguments. It never retries: a retry after an unclear failure can create a
// second campaign or ad. Check with the connection's reading tools first.
// Only inside `adAccounts`, like the connection.
export const metaAdsChangeTool = (opts: { adAccounts: string[]; name?: string }) => {
  if (!opts.adAccounts?.length) throw new Error('metaAdsChangeTool: list the ad accounts the agent may change in adAccounts');
  let guard: AccountGuard | undefined;
  return defineTool({
    description:
      `Change something in ${opts.name ? `${opts.name}'s ` : ''}Meta ads with one call to one of Meta's Ads MCP tools (every call waits for the owner's approval). ` +
      'New campaigns, ad sets and ads are created paused; ' +
      `${META_SPEND_TOOLS.join(' and ')} start spending money. ` +
      `Only in ad account${opts.adAccounts.length > 1 ? 's' : ''} ${opts.adAccounts.join(', ')}. ` +
      "Pass the tool's arguments exactly as its schema in Meta's reference asks; when unsure of a field, read ads_get_field_context first. " +
      'Make one clear change per call. Never call it again after an error or timeout before checking with the reading tools whether the change went through.',
    inputSchema: z.object({
      summary: z
        .string()
        .min(10)
        .describe(
          'For the owner, in plain words: what changes, in which account and campaign, from what to what, and what it costs. Example: "Ad set \'Winter NL – retargeting\': daily budget €40 → €60".',
        ),
      tool: z.enum(META_WRITE_TOOLS).describe("The Meta Ads MCP tool to call."),
      arguments: z.record(z.string(), z.unknown()).describe("The tool's arguments, as in Meta's schema for it."),
    }),
    approval: 'user-approval',
    async execute({ tool, arguments: args }) {
      const endpoint = metaFromEnv();
      await (guard ??= new AccountGuard(endpoint, opts.adAccounts)).check(args);
      const res = await callMeta(endpoint, tool, args);
      const text = (res.content ?? [])
        .filter((c): c is { type: 'text'; text: string } => c?.type === 'text')
        .map((c) => c.text)
        .join('\n');
      if (res.isError) throw new Error(text || `Meta ${tool} failed`);
      if (res.structuredContent) return res.structuredContent;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  });
};
