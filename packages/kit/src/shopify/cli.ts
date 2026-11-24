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
/** Products and collections (write_products) and stock levels (write_inventory). Nothing on orders, customers or discounts. */
export const writeScopes = 'write_products,write_inventory';
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
  const scopes = opts.allowMutations ? `${readScopes},${writeScopes}` : readScopes;

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
