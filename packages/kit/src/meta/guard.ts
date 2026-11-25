// Keeps an agent inside its own ad accounts. A token often reaches more than
// one business (an agency login sees every client), so Crew decides which
// accounts an agent may touch, not the token.
//
// - ad_account_id / ad_account_ids must be one of the allowed accounts.
// - No argument, anywhere in the input, may name another account or business
//   the token can see.
// - ads_get_ad_accounts only lists the allowed accounts.
//
// Ids of objects inside an account (campaigns, catalogs, audiences, pixels)
// cannot be checked without extra calls; the agent only learns them through
// the account-scoped reads above, and every change waits for the owner.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { callMeta, type MetaEndpoint } from './client.ts';

export const normAccount = (id: unknown) => String(id ?? '').trim().replace(/^act_/, '');

/**
 * The connection's ad accounts, set by metaAdsConnection: comma-separated ids
 * (with or without act_). A CREW_ name, so it never clashes with a variable a
 * team names with fromEnv (agents' MCP secrets share one process environment).
 */
export const META_ACCOUNTS_VAR = 'CREW_META_AD_ACCOUNTS';

export function allowedAccountsFromEnv(): string[] {
  const ids = (process.env[META_ACCOUNTS_VAR] ?? '').split(',').map(normAccount).filter(Boolean);
  if (!ids.length) throw new Error(`Meta Ads: no ad accounts are allowed for this agent (${META_ACCOUNTS_VAR} is empty).`);
  return ids;
}

interface AccountRow {
  ad_account_id?: string;
  business_id?: string;
  [k: string]: unknown;
}

function textOf(res: CallToolResult): string {
  return (res.content ?? []).filter((c): c is { type: 'text'; text: string } => c?.type === 'text').map((c) => c.text).join('\n');
}

async function accountRows(endpoint: MetaEndpoint): Promise<AccountRow[]> {
  const res = await callMeta(endpoint, 'ads_get_ad_accounts', {});
  if (res.isError) throw new Error(textOf(res) || 'Meta ads_get_ad_accounts failed');
  const data = (res.structuredContent as { ad_accounts?: AccountRow[] }) ?? JSON.parse(textOf(res));
  return data?.ad_accounts ?? [];
}

export class AccountGuard {
  private forbidden?: Promise<Set<string>>;
  private readonly allowed: Set<string>;
  private readonly endpoint: MetaEndpoint;

  constructor(endpoint: MetaEndpoint, allowed: string[]) {
    this.endpoint = endpoint;
    this.allowed = new Set(allowed.map(normAccount));
  }

  /** Every account and business id the token sees that is not this agent's. */
  private forbiddenIds(): Promise<Set<string>> {
    this.forbidden ??= accountRows(this.endpoint)
      .then((rows) => {
        const ownBusinesses = new Set(rows.filter((r) => this.allowed.has(normAccount(r.ad_account_id))).map((r) => String(r.business_id ?? '')).filter(Boolean));
        const out = new Set<string>();
        for (const r of rows) {
          const acct = normAccount(r.ad_account_id);
          const biz = String(r.business_id ?? '');
          if (acct && !this.allowed.has(acct)) out.add(acct);
          if (biz && !ownBusinesses.has(biz)) out.add(biz);
        }
        return out;
      })
      .catch((err) => {
        this.forbidden = undefined;
        throw err;
      });
    return this.forbidden;
  }

  /** Throws when the input reaches outside the allowed accounts. */
  async check(args: Record<string, unknown>): Promise<void> {
    const named: string[] = [];
    if (args.ad_account_id !== undefined) named.push(normAccount(args.ad_account_id));
    if (Array.isArray(args.ad_account_ids)) named.push(...args.ad_account_ids.map(normAccount));
    const wrong = named.filter((id) => !this.allowed.has(id));
    if (wrong.length) throw new Error(`Refused: ad account ${wrong.join(', ')} is not one this agent may use (allowed: ${[...this.allowed].join(', ')}).`);

    const forbidden = await this.forbiddenIds();
    const hit = scalars(args).map(normAccount).find((v) => forbidden.has(v));
    if (hit) throw new Error(`Refused: ${hit} belongs to another ad account or business than this agent's.`);
  }

  /** ads_get_ad_accounts, reduced to the allowed accounts. */
  async listAllowed(): Promise<CallToolResult> {
    const rows = (await accountRows(this.endpoint)).filter((r) => this.allowed.has(normAccount(r.ad_account_id)));
    const data = { ad_accounts: rows };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  }
}

function scalars(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) scalars(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) scalars(v, out);
  return out;
}
