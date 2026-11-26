// The Search Console tools, on an McpServer that mcp-server.ts connects to
// stdio (and the tests to an in-memory transport). Three reading tools for the
// one property the connection names; the agent cannot pick another. Answers
// are trimmed for an agent's context and say which site, which dates and how
// fresh the data is.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GoogleServiceAccountAuth, KEY_VAR, parseServiceAccountKey } from './auth.ts';
import { normalizeSite, SearchConsoleClient, urlBelongsToSite } from './client.ts';

export { SEARCH_CONSOLE_TOOLS } from './tools.ts';

const FRESHNESS =
  'Search Console data lags about 2-3 days: the most recent days are missing or still change. Dates are Pacific Time. Default ranges end 3 days ago.';
const MAX_ROWS = 1000;
const DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'searchAppearance'] as const;

type Item = Record<string, any>;

function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }] };
}

function asError(err: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: String((err as Error)?.message ?? err) }] };
}

const round = (n: unknown, digits: number) => (typeof n === 'number' ? Number(n.toFixed(digits)) : null);
const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));

/** Today's date in Search Console's time zone (America/Los_Angeles), as YYYY-MM-DD. */
export function pacificToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The last 28 complete days: ends 3 days ago (Pacific Time), starts 27 days before that. */
export function defaultRange(now = new Date()): { startDate: string; endDate: string } {
  const endDate = addDays(pacificToday(now), -3);
  return { startDate: addDays(endDate, -27), endDate };
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export interface SearchConsoleServerOptions {
  site: string;
  /** The service account's JSON key (or base64 of it); read on the first call. */
  readKey: () => string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createSearchConsoleServer(opts: SearchConsoleServerOptions): McpServer {
  const site = normalizeSite(opts.site);
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());

  let client: SearchConsoleClient | undefined;
  const gsc = () => {
    if (!client) {
      const raw = opts.readKey();
      if (!raw?.trim()) {
        throw new Error(`Search Console is not set up: add ${KEY_VAR} (the service account's JSON key, or base64 of it) to the Crew environment (Settings, or .env.local).`);
      }
      client = new SearchConsoleClient(site, new GoogleServiceAccountAuth(parseServiceAccountKey(raw), fetchImpl), fetchImpl);
    }
    return client;
  };

  const server = new McpServer({ name: 'search-console', version: '0.1.0' });
  const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

  server.registerTool(
    'gsc_search_analytics',
    {
      description:
        `Google Search performance for ${site} from Search Console: clicks, impressions, CTR (%) and average position, grouped by the dimensions you pick ` +
        '(query, page, country, device, date, searchAppearance). Default: the last 28 complete days, web search, top 100 rows by clicks. ' +
        'Countries are ISO 3166-1 alpha-3 codes (nld, bel, deu, gbr, usa). Data goes back 16 months. ' +
        FRESHNESS,
      inputSchema: {
        dimensions: z.array(z.enum(DIMENSIONS)).max(4).optional().describe('Group by these, in order. Default ["query"]. Empty array: one total row.'),
        startDate: DATE.optional().describe('First day, YYYY-MM-DD (Pacific Time). Default: 28 days before endDate.'),
        endDate: DATE.optional().describe('Last day, YYYY-MM-DD. Default: 3 days ago (the last complete day).'),
        filters: z
          .array(
            z.object({
              dimension: z.enum(['query', 'page', 'country', 'device', 'searchAppearance']),
              operator: z.enum(['contains', 'equals', 'notContains', 'notEquals', 'includingRegex', 'excludingRegex']).default('equals'),
              expression: z.string().min(1).max(4096).describe('country: alpha-3 code ("nld"); device: DESKTOP, MOBILE or TABLET; regex: RE2 syntax'),
            }),
          )
          .max(10)
          .optional()
          .describe('All must match.'),
        searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional().describe('Default web. discover and googleNews have no query dimension and no position.'),
        rowLimit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Rows to return (1-${MAX_ROWS}). Default 100.`),
        startRow: z.number().int().min(0).optional().describe('Skip this many rows (paging). Default 0.'),
        includeFreshData: z.boolean().optional().describe('Include the last, still-changing days (dataState "all"). Default false: final data only.'),
      },
      annotations: READ,
    },
    async ({ dimensions, startDate, endDate, filters, searchType, rowLimit, startRow, includeFreshData }) => {
      try {
        const dims = dimensions ?? ['query'];
        const type = searchType ?? 'web';
        if (new Set(dims).size !== dims.length) return asError('Each dimension may appear only once.');
        if ((type === 'discover' || type === 'googleNews') && (dims.includes('query') || filters?.some((f) => f.dimension === 'query'))) {
          return asError(`Search Console has no query data for ${type}: group or filter by page, country, device or date instead.`);
        }
        const range = defaultRange(now());
        const end = endDate ?? (startDate && startDate > range.endDate ? startDate : range.endDate);
        const start = startDate ?? addDays(end, -27);
        if (start > end) return asError(`startDate ${start} is after endDate ${end}.`);
        const normalized = (filters ?? []).map((f) => ({
          dimension: f.dimension,
          operator: f.operator,
          expression: f.dimension === 'country' ? f.expression.trim().toLowerCase() : f.dimension === 'device' ? f.expression.trim().toUpperCase() : f.expression,
        }));
        const badCountry = normalized.find((f) => f.dimension === 'country' && /equals/i.test(f.operator) && !/^[a-z]{3}$/.test(f.expression));
        if (badCountry) return asError(`Country "${badCountry.expression}" is not an ISO 3166-1 alpha-3 code (for example nld, bel, deu, gbr, usa).`);
        const limit = rowLimit ?? 100;
        const body = {
          startDate: start,
          endDate: end,
          dimensions: dims,
          type,
          ...(normalized.length ? { dimensionFilterGroups: [{ groupType: 'and', filters: normalized }] } : {}),
          rowLimit: limit,
          startRow: startRow ?? 0,
          dataState: includeFreshData ? 'all' : 'final',
        };
        const r = await gsc().searchAnalytics(body);
        const rows = (r.rows ?? []).map((row) => {
          const out: Item = {};
          dims.forEach((d, i) => (out[d] = row.keys?.[i] ?? null));
          out.clicks = row.clicks;
          out.impressions = row.impressions;
          out.ctr_pct = round(row.ctr * 100, 2);
          if (type !== 'discover' && type !== 'googleNews') out.position = round(row.position, 1);
          return out;
        });
        return asText({
          site,
          search_type: type,
          date_range: { start, end, time_zone: 'America/Los_Angeles' },
          data_state: body.dataState,
          data_freshness: FRESHNESS,
          ...(r.metadata?.first_incomplete_date ? { first_incomplete_date: r.metadata.first_incomplete_date } : {}),
          dimensions: dims,
          ...(normalized.length ? { filters: normalized } : {}),
          aggregation: r.responseAggregationType ?? null,
          sorted_by: dims.includes('date') ? 'date ascending' : 'clicks descending',
          row_count: rows.length,
          more_rows: rows.length === limit ? `probably: ask again with startRow ${(startRow ?? 0) + limit}` : false,
          note: 'Search Console returns top rows only and hides very rare queries for privacy, so rows do not add up to the site total.',
          rows,
        });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'gsc_inspect_url',
    {
      description:
        `URL Inspection for one page of ${site}: whether Google indexed it and why not, the canonical Google chose versus the one the page declares, the last crawl, ` +
        'robots.txt and fetch state, sitemaps and referring pages, rich results found. This is Google\'s indexed data (as of its last crawl), not a live test. ' +
        'Limited to 2,000 calls a day per property.',
      inputSchema: {
        url: z.string().url().describe(`The full page URL, under ${site}`),
        languageCode: z.string().optional().describe('Language of Google\'s messages (BCP-47). Default en-US.'),
      },
      annotations: READ,
    },
    async ({ url, languageCode }) => {
      try {
        if (!urlBelongsToSite(url, site)) return asError(`${url} is not part of the Search Console property ${site}; only pages of ${site} can be inspected.`);
        const r = await gsc().inspect(url, languageCode ?? 'en-US');
        const i = r.inspectionResult ?? {};
        const ix = i.indexStatusResult ?? {};
        const mob = i.mobileUsabilityResult;
        const rich = i.richResultsResult;
        const amp = i.ampResult;
        return asText({
          site,
          url,
          checked_at: now().toISOString(),
          data_freshness: 'Index data as Google last crawled and processed the page (see last_crawl), not a live fetch.',
          verdict: ix.verdict ?? null,
          coverage: ix.coverageState ?? null,
          indexing_state: ix.indexingState ?? null,
          robots_txt: ix.robotsTxtState ?? null,
          page_fetch: ix.pageFetchState ?? null,
          last_crawl: ix.lastCrawlTime ?? null,
          crawled_as: ix.crawledAs ?? null,
          google_canonical: ix.googleCanonical ?? null,
          user_canonical: ix.userCanonical ?? null,
          canonical_mismatch: Boolean(ix.googleCanonical && ix.userCanonical && ix.googleCanonical !== ix.userCanonical),
          sitemaps: (ix.sitemap ?? []).slice(0, 10),
          referring_urls: (ix.referringUrls ?? []).slice(0, 10),
          ...(mob ? { mobile_usability: { verdict: mob.verdict ?? null, issues: (mob.issues ?? []).map((x: Item) => x.message ?? x.issueType) } } : {}),
          ...(rich
            ? {
                rich_results: {
                  verdict: rich.verdict ?? null,
                  detected: (rich.detectedItems ?? []).map((d: Item) => ({
                    type: d.richResultType,
                    items: (d.items ?? []).slice(0, 10).map((it: Item) => ({
                      name: it.name ?? null,
                      issues: (it.issues ?? []).map((x: Item) => `${x.severity ?? ''} ${x.issueMessage ?? ''}`.trim()),
                    })),
                  })),
                },
              }
            : {}),
          ...(amp ? { amp: { verdict: amp.verdict ?? null, url: amp.ampUrl ?? null, issues: (amp.issues ?? []).map((x: Item) => x.issueMessage) } } : {}),
          report_link: i.inspectionResultLink ?? null,
        });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'gsc_sitemaps',
    {
      description: `The sitemaps submitted for ${site} in Search Console: status, errors, warnings, URLs submitted per type, when Google last downloaded each.`,
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      try {
        const r = await gsc().sitemaps();
        const sitemaps = (r.sitemap ?? []).map((s) => ({
          path: s.path,
          type: s.type ?? null,
          is_index: s.isSitemapsIndex ?? false,
          status: s.isPending ? 'pending' : num(s.errors) ? 'has errors' : 'processed',
          errors: num(s.errors) ?? 0,
          warnings: num(s.warnings) ?? 0,
          last_submitted: s.lastSubmitted ?? null,
          last_downloaded: s.lastDownloaded ?? null,
          submitted_urls: (s.contents ?? []).map((c) => ({ type: c.type ?? null, submitted: num(c.submitted) })),
        }));
        return asText({
          site,
          checked_at: now().toISOString(),
          data_freshness: 'As Search Console last processed each sitemap (see last_downloaded).',
          count: sitemaps.length,
          sitemaps,
        });
      } catch (err) {
        return asError(err);
      }
    },
  );

  return server;
}
