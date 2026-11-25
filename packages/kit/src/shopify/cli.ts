// Shopify Admin GraphQL through the Shopify CLI's stored authentication.
// Shared by the read-only MCP server (mcp-server.ts) and the store manager's
// approval-gated shopify_mutate tool.

import { execFile, type ExecFileException } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify, stripVTControlCharacters } from 'node:util';
import { Kind, OperationTypeNode, parse } from 'graphql';

/** What the store manager can look at. Markets, languages, locations and discounts are read so questions about them can be answered. */
export const readScopes =
  'read_products,read_inventory,read_orders,read_customers,read_markets,read_locales,read_locations,read_discounts';
/**
 * Full control over the store. Every change still waits for the owner's approval in the Inbox
 * (shopify_mutate), so the token can do whatever the owner could do in Shopify Admin.
 * A write scope implies its read scope. Protected scopes that need Shopify's review
 * (read_all_orders, payment methods, staff accounts) are left out: asking for them can fail the sign-in.
 */
export const writeScopes = [
  // Catalogue and stock
  'write_products', 'write_inventory', 'write_product_listings', 'write_publications', 'write_files',
  'write_metaobjects', 'write_metaobject_definitions', 'write_purchase_options',
  // Orders, customers and fulfilment
  'write_orders', 'write_draft_orders', 'write_order_edits', 'write_customers', 'write_returns',
  'write_fulfillments', 'write_assigned_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
  'write_third_party_fulfillment_orders', 'write_gift_cards',
  // Markets, languages, shipping and locations
  'write_markets', 'write_locales', 'write_translations', 'write_shipping', 'write_locations',
  // Discounts and marketing
  'write_discounts', 'write_price_rules', 'write_marketing_events',
  // Online store
  'write_themes', 'write_content', 'write_online_store_pages', 'write_online_store_navigation',
  'write_legal_policies', 'write_script_tags',
  // Checkout customisations
  'write_delivery_customizations', 'write_payment_customizations', 'write_cart_transforms', 'write_validations',
].join(',');
/** What to sign in with: everything the read path and shopify_mutate need. */
export const authScopes = `${readScopes},${writeScopes}`;
const timeoutMs = 30_000;
const execShopify = promisify(execFile);

/**
 * Parse the document with GraphQL's own parser and accept it only if it is
 * valid and every operation in it is of the given kind (fragments are fine).
 * Anything that does not parse is refused too.
 */
function onlyOperations(query: string, kind: OperationTypeNode): boolean {
  let doc;
  try {
    doc = parse(query);
  } catch {
    return false;
  }
  let operations = 0;
  for (const def of doc.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) {
      operations++;
      if (def.operation !== kind) return false;
    } else if (def.kind !== Kind.FRAGMENT_DEFINITION) {
      return false;
    }
  }
  return operations > 0;
}

export const isReadOnlyQuery = (query: string) => onlyOperations(query, OperationTypeNode.QUERY);
export const isMutation = (query: string) => onlyOperations(query, OperationTypeNode.MUTATION);

/**
 * The root fields a document selects across its operations (for example
 * ['metafieldsSet']), so a tool can allow only some mutations. Fragment spreads
 * and inline fragments at the root show as '<FragmentSpread>' / '<InlineFragment>'
 * and match no allow-list. Empty when the document does not parse.
 */
export function rootFields(query: string): string[] {
  let doc;
  try {
    doc = parse(query);
  } catch {
    return [];
  }
  const fields: string[] = [];
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const sel of def.selectionSet.selections) fields.push(sel.kind === Kind.FIELD ? sel.name.value : `<${sel.kind}>`);
  }
  return fields;
}

/**
 * Runs one Admin GraphQL operation against `store` (its myshopify.com domain)
 * through the Shopify CLI's stored authentication.
 */
export async function graphql(
  store: string,
  query: string,
  variables?: Record<string, unknown>,
  opts: { allowMutations?: boolean } = {},
): Promise<unknown> {
  if (!store) throw new Error('No Shopify store set. Set shopify.store in crew.config.ts or SHOPIFY_STORE.');
  const args = ['store', 'execute', '--store', store, '--json', '--query', query];
  if (variables !== undefined) args.push('--variables', JSON.stringify(variables));
  if (opts.allowMutations) args.push('--allow-mutations');
  // Always ask for the full set, so signing in again after a read error never drops write access.
  const scopes = authScopes;

  let stdout: string;
  try {
    ({ stdout } = await execShopify('shopify', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      // Codex and Grok sessions run with their own HOME; the Shopify CLI keeps its login in the real one.
      env: { ...process.env, HOME: userInfo().homedir },
    }));
  } catch (err) {
    const failure = err as ExecFileException & { stdout: string; stderr: string };
    if (failure.code === 'ENOENT') throw new Error('Shopify CLI was not found on PATH.');
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error('Shopify CLI output exceeded 4 MiB. Request fewer fields or a smaller page.');
    }
    if (failure.killed) throw new Error(`Shopify CLI timed out after ${timeoutMs / 1000} seconds.`);

    const detail = cliError(failure.stdout) ?? stripVTControlCharacters(failure.stderr || failure.stdout || '').trim();
    if (/no stored app authentication|stored app authentication.*(?:expired|no longer valid)/i.test(detail)) {
      throw new Error(
        `Shopify CLI needs stored authentication for ${store}. Ask the owner to run: ` +
          `shopify store auth --store ${store} --scopes ${scopes}`,
      );
    }
    const missing = /Required access: `?(\w+)`?/i.exec(detail)?.[1];
    if (!opts.allowMutations && missing) {
      throw new Error(
        `Shopify refused the query: the stored authentication lacks ${missing}. Ask the owner to sign in to Shopify again ` +
          `(Shopify → Sign in in Crew's sidebar, or: shopify store auth --store ${store} --scopes ${scopes}).\n${detail.slice(0, 1500)}`,
      );
    }
    if (opts.allowMutations && /access denied|scope/i.test(detail)) {
      throw new Error(
        `Shopify refused the change; the stored authentication probably lacks write access. Ask the owner to run: ` +
          `shopify store auth --store ${store} --scopes ${scopes}\n${detail.slice(0, 1500)}`,
      );
    }
    throw new Error(`Shopify CLI query failed (exit ${failure.code ?? 'unknown'}).${detail ? `\n${detail.slice(0, 1500)}` : ''}`);
  }

  try {
    // The CLI prints the data object. Preserve the Admin API response shape.
    return { data: JSON.parse(stdout) };
  } catch {
    throw new Error('Shopify CLI returned invalid JSON.');
  }
}

/**
 * With --json the CLI prints progress events on stderr and the failure as one
 * {"error": …} line on stdout. Return Shopify's own error messages from it, so
 * the reason (for example a missing access scope) reaches the agent.
 */
function cliError(stdout: string | undefined): string | undefined {
  for (const line of (stdout ?? '').split('\n').reverse()) {
    let parsed: { error?: { message?: string; details?: { errors?: { message?: string }[] } } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed?.error) continue;
    const messages = (parsed.error.details?.errors ?? []).map((e) => e.message).filter(Boolean);
    return (messages.length ? messages.join('\n') : parsed.error.message) || undefined;
  }
  return undefined;
}
