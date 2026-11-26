// node --test: the Search Console connection without real credentials. A
// throwaway RSA key signs the JWT; Google's token endpoint and the Search
// Console API are a mocked fetch answering with the response shapes from
// Google's API reference. One run of the real stdio server lists its tools.

import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GOOGLE_TOKEN_URL, GoogleServiceAccountAuth, parseServiceAccountKey, SEARCH_CONSOLE_SCOPE, signServiceAccountJwt } from './auth.ts';
import { normalizeSite, urlBelongsToSite } from './client.ts';
import { searchConsoleConnection } from './connection.ts';
import { createSearchConsoleServer, defaultRange } from './server.ts';
import { SEARCH_CONSOLE_TOOLS } from './tools.ts';

const SITE = 'sc-domain:wakey.care';
const EMAIL = 'crew-seo@wakey-crew.iam.gserviceaccount.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyJson = JSON.stringify({
  type: 'service_account',
  project_id: 'wakey-crew',
  private_key_id: 'abc123',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: EMAIL,
  client_id: '1234567890',
  token_uri: GOOGLE_TOKEN_URL,
});

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

interface Call {
  url: string;
  method: string;
  body: any;
  auth?: string;
}

type Route = (call: Call) => { status?: number; json: unknown } | undefined;

/** A fetch that records every call and answers from the routes (first match wins). */
function mockFetch(routes: Route[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const body = raw instanceof URLSearchParams ? Object.fromEntries(raw) : typeof raw === 'string' ? JSON.parse(raw) : undefined;
    const call: Call = { url, method: init?.method ?? 'GET', body, auth: (init?.headers as Record<string, string> | undefined)?.authorization };
    calls.push(call);
    for (const route of routes) {
      const r = route(call);
      if (r) return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { code: 404, message: `no mock for ${url}`, status: 'NOT_FOUND' } }), { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const tokenRoute: Route = (c) => (c.url === GOOGLE_TOKEN_URL ? { json: { access_token: 'ya29.test-token', expires_in: 3599, token_type: 'Bearer' } } : undefined);

async function connect(fetchImpl: typeof fetch, key: string | undefined = keyJson, site = SITE) {
  const server = createSearchConsoleServer({ site, readKey: () => key, fetch: fetchImpl, now: () => new Date('2026-11-26T12:00:00Z') });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]!.text;
  return { isError: Boolean(r.isError), text, json: r.isError ? undefined : JSON.parse(text) };
}

describe('service account key and JWT', () => {
  it('reads the key as JSON and as base64, and signs a verifiable RS256 JWT', () => {
    const plain = parseServiceAccountKey(keyJson);
    const b64 = parseServiceAccountKey(Buffer.from(keyJson).toString('base64'));
    assert.equal(plain.clientEmail, EMAIL);
    assert.equal(b64.clientEmail, EMAIL);

    const jwt = signServiceAccountJwt(plain, 1_800_000_000);
    const parts = jwt.split('.');
    assert.equal(parts.length, 3);
    assert.deepEqual(decode(parts[0]!), { alg: 'RS256', typ: 'JWT', kid: 'abc123' });
    assert.deepEqual(decode(parts[1]!), { iss: EMAIL, scope: SEARCH_CONSOLE_SCOPE, aud: GOOGLE_TOKEN_URL, iat: 1_800_000_000, exp: 1_800_003_600 });
    const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(publicKey, Buffer.from(parts[2]!, 'base64url'));
    assert.ok(ok, 'signature verifies with the public key');
  });

  it('accepts a private key whose newlines arrived as \\n', () => {
    const escaped = keyJson.replace(/\\n/g, '\\\\n');
    assert.equal(parseServiceAccountKey(escaped).clientEmail, EMAIL);
  });

  it('refuses missing or malformed keys without quoting them', () => {
    assert.throws(() => parseServiceAccountKey(undefined), /GOOGLE_SEARCH_CONSOLE_KEY is empty/);
    assert.throws(() => parseServiceAccountKey('{"secret-ish": '), (e: Error) => /neither JSON nor base64/.test(e.message) && !e.message.includes('secret-ish'));
    assert.throws(() => parseServiceAccountKey(JSON.stringify({ type: 'authorized_user' })), /not a service account key/);
    assert.throws(() => parseServiceAccountKey(JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----' })), /could not be read/);
  });

  it('exchanges the JWT once and caches the token until it nearly expires', async () => {
    let t = 1_800_000_000_000;
    const { impl, calls } = mockFetch([tokenRoute]);
    const auth = new GoogleServiceAccountAuth(parseServiceAccountKey(keyJson), impl, () => t);
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    assert.equal(a, 'ya29.test-token');
    assert.equal(b, a);
    assert.equal(calls.length, 1, 'parallel calls share one sign-in');
    assert.equal(calls[0]!.body.grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(decode(calls[0]!.body.assertion.split('.')[1]).iss, EMAIL);
    t += 30 * 60_000;
    await auth.accessToken();
    assert.equal(calls.length, 1, 'still cached after 30 minutes');
    t += 30 * 60_000;
    await auth.accessToken();
    assert.equal(calls.length, 2, 'renewed near expiry');
  });

  it('explains a refused key', async () => {
    const { impl } = mockFetch([(c) => (c.url === GOOGLE_TOKEN_URL ? { status: 400, json: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } : undefined)]);
    const auth = new GoogleServiceAccountAuth(parseServiceAccountKey(keyJson), impl);
    await assert.rejects(auth.accessToken(), /invalid_grant: Invalid JWT Signature.*create a new JSON key/);
  });
});

describe('site handling', () => {
  it('normalizes properties and checks URLs against them', () => {
    assert.equal(normalizeSite('sc-domain:Wakey.care'), 'sc-domain:wakey.care');
    assert.equal(normalizeSite('https://wakey.care'), 'https://wakey.care/');
    assert.throws(() => normalizeSite('wakey.care'), /not a property/);
    assert.ok(urlBelongsToSite('https://wakey.care/products/x', SITE));
    assert.ok(urlBelongsToSite('http://www.wakey.care/', SITE));
    assert.ok(!urlBelongsToSite('https://notwakey.care/', SITE));
    assert.ok(!urlBelongsToSite('https://wakey.care.evil.com/', SITE));
    assert.ok(urlBelongsToSite('https://wakey.care/nl/a', 'https://wakey.care/nl/'));
    assert.ok(!urlBelongsToSite('https://wakey.care/de/a', 'https://wakey.care/nl/'));
  });

  it('the connection passes the site and the key reference, and allows only the gsc tools', () => {
    const c = searchConsoleConnection({ site: 'sc-domain:wakey.care' }) as any;
    assert.equal(c.env.CREW_GSC_SITE, SITE);
    assert.deepEqual(c.env.GOOGLE_SEARCH_CONSOLE_KEY, { fromEnv: 'GOOGLE_SEARCH_CONSOLE_KEY' });
    assert.deepEqual(c.tools.allow, [...SEARCH_CONSOLE_TOOLS]);
  });

  it('the default range is the last 28 complete days, ending 3 days ago in Pacific Time', () => {
    // 2026-11-26 03:00 UTC is still 25 November in California.
    assert.deepEqual(defaultRange(new Date('2026-11-26T03:00:00Z')), { startDate: '2026-10-26', endDate: '2026-11-22' });
  });
});

describe('tools against a mocked Search Console', () => {
  it('gsc_search_analytics sends the query and trims the rows', async () => {
    const { impl, calls } = mockFetch([
      tokenRoute,
      (c) =>
        c.url.endsWith('/sites/sc-domain%3Awakey.care/searchAnalytics/query')
          ? {
              json: {
                rows: [
                  { keys: ['wakey nasal strips', 'nld'], clicks: 412, impressions: 3810, ctr: 0.10813648293963255, position: 1.8346456692913387 },
                  { keys: ['neusstrips', 'nld'], clicks: 97, impressions: 6120, ctr: 0.015849673202614378, position: 7.412091503267974 },
                ],
                responseAggregationType: 'byProperty',
              },
            }
          : undefined,
    ]);
    const client = await connect(impl);
    const r = await call(client, 'gsc_search_analytics', {
      dimensions: ['query', 'country'],
      filters: [
        { dimension: 'country', operator: 'equals', expression: 'NLD' },
        { dimension: 'query', operator: 'contains', expression: 'strip' },
      ],
      rowLimit: 2,
    });
    assert.equal(r.isError, false, r.text);
    const req = calls.find((c) => c.url.includes('searchAnalytics'))!;
    assert.equal(req.auth, 'Bearer ya29.test-token');
    assert.deepEqual(req.body, {
      startDate: '2026-10-27',
      endDate: '2026-11-23',
      dimensions: ['query', 'country'],
      type: 'web',
      dimensionFilterGroups: [
        {
          groupType: 'and',
          filters: [
            { dimension: 'country', operator: 'equals', expression: 'nld' },
            { dimension: 'query', operator: 'contains', expression: 'strip' },
          ],
        },
      ],
      rowLimit: 2,
      startRow: 0,
      dataState: 'final',
    });
    assert.equal(r.json.site, SITE);
    assert.deepEqual(r.json.date_range, { start: '2026-10-27', end: '2026-11-23', time_zone: 'America/Los_Angeles' });
    assert.match(r.json.data_freshness, /2-3 days/);
    assert.deepEqual(r.json.rows[0], { query: 'wakey nasal strips', country: 'nld', clicks: 412, impressions: 3810, ctr_pct: 10.81, position: 1.8 });
    assert.match(r.json.more_rows, /startRow 2/);
  });

  it('gsc_search_analytics refuses what Search Console cannot answer', async () => {
    const client = await connect(mockFetch([tokenRoute]).impl);
    assert.match((await call(client, 'gsc_search_analytics', { searchType: 'discover' })).text, /no query data for discover/);
    assert.match((await call(client, 'gsc_search_analytics', { filters: [{ dimension: 'country', expression: 'NL' }] })).text, /alpha-3/);
    assert.match((await call(client, 'gsc_search_analytics', { startDate: '2026-11-10', endDate: '2026-11-01' })).text, /after endDate/);
    assert.equal((await call(client, 'gsc_search_analytics', { rowLimit: 5000 })).isError, true);
  });

  it('gsc_inspect_url returns index status, canonicals and rich results', async () => {
    const { impl, calls } = mockFetch([
      tokenRoute,
      (c) =>
        c.url === 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
          ? {
              json: {
                inspectionResult: {
                  inspectionResultLink: 'https://search.google.com/search-console/inspect?resource_id=sc-domain:wakey.care&id=abc',
                  indexStatusResult: {
                    verdict: 'PASS',
                    coverageState: 'Submitted and indexed',
                    robotsTxtState: 'ALLOWED',
                    indexingState: 'INDEXING_ALLOWED',
                    lastCrawlTime: '2026-11-20T08:14:03Z',
                    pageFetchState: 'SUCCESSFUL',
                    googleCanonical: 'https://wakey.care/products/nasal-strips',
                    userCanonical: 'https://wakey.care/nl/products/nasal-strips',
                    sitemap: ['https://wakey.care/sitemap.xml'],
                    referringUrls: ['https://wakey.care/'],
                    crawledAs: 'MOBILE',
                  },
                  mobileUsabilityResult: { verdict: 'PASS', issues: [] },
                  richResultsResult: {
                    verdict: 'PASS',
                    detectedItems: [{ richResultType: 'Product snippets', items: [{ name: 'Wakey Nasal Strips', issues: [{ issueMessage: 'Missing field "review"', severity: 'WARNING' }] }] }],
                  },
                },
              },
            }
          : undefined,
    ]);
    const client = await connect(impl);
    const r = await call(client, 'gsc_inspect_url', { url: 'https://wakey.care/nl/products/nasal-strips' });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(calls.at(-1)!.body, { inspectionUrl: 'https://wakey.care/nl/products/nasal-strips', siteUrl: SITE, languageCode: 'en-US' });
    assert.equal(r.json.coverage, 'Submitted and indexed');
    assert.equal(r.json.canonical_mismatch, true);
    assert.equal(r.json.last_crawl, '2026-11-20T08:14:03Z');
    assert.deepEqual(r.json.rich_results.detected[0].items[0].issues, ['WARNING Missing field "review"']);

    const outside = await call(client, 'gsc_inspect_url', { url: 'https://example.com/' });
    assert.equal(outside.isError, true);
    assert.match(outside.text, /not part of the Search Console property sc-domain:wakey.care/);
  });

  it('gsc_sitemaps lists sitemaps with numbers from Google\'s string longs', async () => {
    const { impl } = mockFetch([
      tokenRoute,
      (c) =>
        c.url.endsWith('/sites/sc-domain%3Awakey.care/sitemaps')
          ? {
              json: {
                sitemap: [
                  {
                    path: 'https://wakey.care/sitemap.xml',
                    lastSubmitted: '2026-10-01T09:00:00.000Z',
                    isPending: false,
                    isSitemapsIndex: true,
                    type: 'sitemap',
                    lastDownloaded: '2026-11-24T03:12:45.211Z',
                    warnings: '2',
                    errors: '0',
                    contents: [{ type: 'web', submitted: '412', indexed: '0' }, { type: 'image', submitted: '980', indexed: '0' }],
                  },
                ],
              },
            }
          : undefined,
    ]);
    const r = await call(await connect(impl), 'gsc_sitemaps');
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.sitemaps[0], {
      path: 'https://wakey.care/sitemap.xml',
      type: 'sitemap',
      is_index: true,
      status: 'processed',
      errors: 0,
      warnings: 2,
      last_submitted: '2026-10-01T09:00:00.000Z',
      last_downloaded: '2026-11-24T03:12:45.211Z',
      submitted_urls: [{ type: 'web', submitted: 412 }, { type: 'image', submitted: 980 }],
    });
  });
});

describe('setup errors', () => {
  const forbidden: Route = (c) =>
    c.url.includes('/sites/sc-domain')
      ? { status: 403, json: { error: { code: 403, message: "User does not have sufficient permission for site 'sc-domain:wakey.care'. See also: https://support.google.com/webmasters/answer/2451999.", status: 'PERMISSION_DENIED' } } }
      : undefined;

  it('no key: says which variable to set', async () => {
    const r = await call(await connect(mockFetch([]).impl, ''), 'gsc_sitemaps');
    assert.equal(r.isError, true);
    assert.match(r.text, /not set up: add GOOGLE_SEARCH_CONSOLE_KEY/);
  });

  it('not added to any property: says how to add the service account', async () => {
    const { impl } = mockFetch([tokenRoute, forbidden, (c) => (c.url.endsWith('/webmasters/v3/sites') ? { json: {} } : undefined)]);
    const r = await call(await connect(impl), 'gsc_sitemaps');
    assert.equal(r.isError, true);
    assert.match(r.text, new RegExp(`${EMAIL} has no access to any Search Console property`));
    assert.match(r.text, /Settings → Users and permissions → Add user/);
  });

  it('wrong site string: lists the properties the account can see', async () => {
    const { impl } = mockFetch([
      tokenRoute,
      forbidden,
      (c) => (c.url.endsWith('/webmasters/v3/sites') ? { json: { siteEntry: [{ siteUrl: 'https://wakey.care/', permissionLevel: 'siteRestrictedUser' }] } } : undefined),
    ]);
    const r = await call(await connect(impl), 'gsc_search_analytics');
    assert.equal(r.isError, true);
    assert.match(r.text, /It can see: https:\/\/wakey.care\/ \(siteRestrictedUser\)/);
  });

  it('API not enabled in the Cloud project: says to enable it', async () => {
    const { impl } = mockFetch([
      tokenRoute,
      (c) =>
        c.url.includes('/sites/')
          ? {
              status: 403,
              json: {
                error: {
                  code: 403,
                  message: 'Google Search Console API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=123456 then retry.',
                  status: 'PERMISSION_DENIED',
                  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }],
                },
              },
            }
          : undefined,
    ]);
    const r = await call(await connect(impl), 'gsc_sitemaps');
    assert.match(r.text, /API is not enabled/);
  });

  it('a revoked token is renewed once', async () => {
    let first = true;
    const { impl, calls } = mockFetch([
      tokenRoute,
      (c) => {
        if (!c.url.endsWith('/sitemaps')) return undefined;
        if (first) {
          first = false;
          return { status: 401, json: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } };
        }
        return { json: { sitemap: [] } };
      },
    ]);
    const r = await call(await connect(impl), 'gsc_sitemaps');
    assert.equal(r.isError, false, r.text);
    assert.equal(calls.filter((c) => c.url === GOOGLE_TOKEN_URL).length, 2);
  });
});

describe('stdio server', () => {
  it('starts without credentials and lists its three tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-server.ts', import.meta.url))],
      env: { PATH: process.env.PATH ?? '', CREW_GSC_SITE: SITE },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [...SEARCH_CONSOLE_TOOLS].sort());
      assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
      const r = (await client.callTool({ name: 'gsc_sitemaps', arguments: {} })) as { isError?: boolean; content: { text: string }[] };
      assert.equal(r.isError, true);
      assert.match(r.content[0]!.text, /GOOGLE_SEARCH_CONSOLE_KEY/);
    } finally {
      await client.close();
    }
  });
});
