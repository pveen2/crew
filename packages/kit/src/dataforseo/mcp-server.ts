// Read-only DataForSEO MCP server (stdio). Started by the agent CLI through
// connection.ts (dataForSeoConnection). Six tools over DataForSEO's live
// endpoints, each trimmed to what an SEO answer needs: DataForSEO's raw
// responses are far too large for an agent's context.
//
// Coverage differs per data source (checked 25 November 2026):
// - SERP and Google Ads keyword data: any country and language.
// - DataForSEO Labs (a domain's rankings, competitors): a few languages per
//   country only, e.g. Netherlands = Dutch, United Kingdom = English.
//
// Every call costs money. CREW_DATAFORSEO_MAX_COST (USD) caps what one agent
// session spends. The conductor starts this server again for every turn, so the
// running total lives in a file per session (CREW_SESSION_ID) in the folder the
// conductor gives this connection (CREW_STATE_DIR, under CREW_HOME), which
// survives restarts. Calls run one at a time; a call is refused when its
// expected cost would go over the cap, or when the total can't be read or saved.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { callDataForSeo, dataForSeoFromEnv, DataForSeoError, type TaskResult } from './client.ts';

const LOCATION = process.env.CREW_DATAFORSEO_LOCATION?.trim() || 'Netherlands';
const LANGUAGE = process.env.CREW_DATAFORSEO_LANGUAGE?.trim() || 'en';
const MAX_COST = Number(process.env.CREW_DATAFORSEO_MAX_COST) > 0 ? Number(process.env.CREW_DATAFORSEO_MAX_COST) : 2;

const SPEND_DIR = process.env.CREW_STATE_DIR?.trim() || join(tmpdir(), 'crew-dataforseo');
const SPEND_FILE = join(SPEND_DIR, `${(process.env.CREW_SESSION_ID?.trim() || `pid-${process.pid}`).replace(/[^\w.-]/g, '_')}.json`);

/** The session's total so far. Throws when the file exists but can't be read: no budget, no calls. */
function readSpent(): number {
  let text: string;
  try {
    text = readFileSync(SPEND_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new Error(`Refused: can't read this session's DataForSEO spend (${(err as Error).message}).`);
  }
  let spent = Number.NaN;
  try {
    spent = Number(JSON.parse(text || '{}').spent);
  } catch {}
  if (!Number.isFinite(spent) || spent < 0) throw new Error(`Refused: this session's DataForSEO spend file is damaged (${SPEND_FILE}).`);
  return spent;
}

function book(cost: number): number {
  const spent = readSpent() + cost;
  mkdirSync(SPEND_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SPEND_FILE, JSON.stringify({ spent }), { mode: 0o600 });
  return spent;
}

// One call at a time, so parallel calls can't all pass the budget check.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/** A paid call within the session budget. `estimate` is the expected cost in USD. */
function paid(path: string, task: Item, estimate: number, signal?: AbortSignal): Promise<TaskResult<Item> & { spent: number }> {
  return serial(async () => {
    // The caller may have given up while this call waited its turn.
    if (signal?.aborted) throw new Error('Cancelled before it was sent; nothing was charged.');
    // Saving must work before anything is spent, or charges would go unrecorded.
    const before = book(0);
    if (before + estimate > MAX_COST) {
      throw new Error(
        `Refused: this session has spent $${before.toFixed(2)} on DataForSEO and this call costs about $${estimate.toFixed(3)}; the limit is $${MAX_COST}. ` +
          'Report what you have, or ask the owner to continue in a new thread.',
      );
    }
    try {
      const r = await callDataForSeo<Item>(dataForSeoFromEnv(), path, task);
      return { ...r, spent: book(r.cost) };
    } catch (err) {
      if (err instanceof DataForSeoError && err.cost) book(err.cost);
      throw err;
    }
  });
}

type Item = Record<string, any>;

function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }] };
}

function asError(err: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: String((err as Error)?.message ?? err) }] };
}

const round = (n: unknown, digits = 2) => (typeof n === 'number' ? Number(n.toFixed(digits)) : (n ?? null));
const clip = (s: unknown, max: number) => (typeof s === 'string' ? (s.length > max ? `${s.slice(0, max)}…` : s) : (s ?? null));

/** The newest month in Google Ads' monthly series ("2026-10"): what the 12-month average runs to. */
const dataThrough = (rows: Item[]) => {
  const m = rows.find((k) => Array.isArray(k.monthly_searches) && k.monthly_searches.length)?.monthly_searches[0];
  return m ? `${m.year}-${String(m.month).padStart(2, '0')}` : null;
};

/** Twelve months as "2026-10: 210", newest first. */
const monthly = (m: unknown) =>
  Array.isArray(m) ? m.slice(0, 12).map((x: Item) => `${x.year}-${String(x.month).padStart(2, '0')}: ${x.search_volume ?? '?'}`) : null;

/** One live call within the session budget, with location and language filled in. */
async function run(path: string, task: Item, place: { location?: string; language?: string }, estimate: number, signal?: AbortSignal) {
  const location = place.location?.trim() || LOCATION;
  const full = {
    ...task,
    ...(/^\d+$/.test(location) ? { location_code: Number(location) } : { location_name: location }),
    language_code: place.language?.trim() || LANGUAGE,
  };
  try {
    const { result, cost, warning, spent } = await paid(path, full, estimate, signal);
    return {
      result,
      meta: { location, language: full.language_code, ...(warning ? { warning } : {}), cost_usd: round(cost, 4), session_spent_usd: round(spent, 4), session_limit_usd: MAX_COST },
    };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (path.startsWith('dataforseo_labs/') && /language_code|location/.test(msg)) {
      throw new Error(`${msg.replace(/\.+$/, '')}. DataForSEO Labs covers only some languages per country (Netherlands: nl only; United Kingdom: en). Retry with a supported language, or use seo_search_volume / seo_keyword_ideas, which cover every language.`);
    }
    throw err;
  }
}

/** The result's link, unless it is one of Google's redirect links. */
const realUrl = (url: unknown) => (typeof url === 'string' && !/^https?:\/\/(www\.)?google\.[a-z.]+\/(goto|url)\b/.test(url) ? url : null);

const place = {
  location: z.string().optional().describe(`Country or location name ("Netherlands", "Belgium", "United Kingdom") or numeric location code. Default: ${LOCATION}.`),
  language: z.string().optional().describe(`Language code of the searches ("en", "nl", "de"). Default: ${LANGUAGE}.`),
};

const server = new McpServer({ name: 'dataforseo', version: '0.1.0' });
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

server.registerTool(
  'seo_google_serp',
  {
    description:
      'Live Google results for one search: who ranks (organic, in order), plus the AI overview, People also ask and other features on the page. ' +
      'Organic results show the site, and the page URL where DataForSEO resolved it (otherwise Google\'s breadcrumb path). About $0.004-0.02 per call, depending on depth.',
    inputSchema: {
      keyword: z.string().min(1).describe('The search, exactly as people type it'),
      ...place,
      depth: z.number().int().min(10).max(100).optional().describe('How many results to read (10-100). Default 20.'),
      device: z.enum(['desktop', 'mobile']).optional().describe('Default desktop.'),
    },
    annotations: READ,
  },
  async ({ keyword, location, language, depth, device }, { signal }) => {
    try {
      const { result, meta } = await run(
        'serp/google/organic/live/advanced',
        { keyword, depth: depth ?? 20, device: device ?? 'desktop', load_async_ai_overview: true },
        { location, language },
        // Search operators (site:, intitle:, …) cost five times as much.
        (/\b(site|inurl|intitle|intext|allinurl|allintitle|allintext|related|cache):/i.test(keyword) ? 5 : 1) * 0.002 * Math.ceil((depth ?? 20) / 10) + 0.002,
        signal,
      );
      const r = result[0] ?? {};
      const items = (r.items ?? []).map((i: Item) => {
        const base = { rank: i.rank_absolute, type: i.type };
        if (i.type === 'organic') {
          return { ...base, organic_rank: i.rank_group, site: i.website_name ?? i.domain ?? null, page: realUrl(i.url) ?? i.breadcrumb ?? null, title: i.title, description: clip(i.description, 240) };
        }
        if (i.type === 'ai_overview') {
          const text = typeof i.markdown === 'string' ? i.markdown.replace(/!\[[^\]]*\]\([^)]*\)\n?/g, '').replace(/\(https:\/\/google\.com\/goto[^)]*\)/g, '') : null;
          return { ...base, text: clip(text, 1500) };
        }
        if (i.type === 'people_also_ask') return { ...base, questions: (i.items ?? []).map((q: Item) => q.title) };
        if (i.type === 'related_searches') return { ...base, searches: i.items ?? [] };
        return { ...base, title: i.title ?? null, count: Array.isArray(i.items) ? i.items.length : undefined };
      });
      return asText({ keyword: r.keyword ?? keyword, ...meta, results_on_google: r.se_results_count ?? null, page_features: r.item_types ?? [], items });
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  'seo_search_volume',
  {
    description:
      'Google Ads search volume for up to 100 keywords: average monthly searches, the last 12 months, competition (for ads) and cost per click in USD. ' +
      'Works for every country and language. About $0.09 per call, whatever the number of keywords: batch them.',
    inputSchema: {
      keywords: z.array(z.string().min(1)).min(1).max(100).describe('Keywords, exactly as people search them'),
      ...place,
    },
    annotations: READ,
  },
  async ({ keywords, location, language }, { signal }) => {
    try {
      const { result, meta } = await run('keywords_data/google_ads/search_volume/live', { keywords }, { location, language }, 0.09, signal);
      const rows = result.map((k) => ({
        keyword: k.keyword,
        search_volume: k.search_volume ?? null,
        competition: k.competition ?? null,
        cpc_usd: round(k.cpc),
        monthly: monthly(k.monthly_searches),
      }));
      return asText({ ...meta, search_volume_is: 'average monthly searches over the last 12 months (Google Ads)', data_through: dataThrough(result), keywords: rows });
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  'seo_keyword_ideas',
  {
    description:
      'Keyword ideas from Google Ads for up to 20 seed keywords: related searches with their monthly volume, competition and cost per click, highest volume first. ' +
      'Works for every country and language. About $0.09 per call.',
    inputSchema: {
      keywords: z.array(z.string().min(1)).min(1).max(20).describe('Seed keywords'),
      ...place,
      limit: z.number().int().min(1).max(200).optional().describe('How many ideas to return. Default 50.'),
    },
    annotations: READ,
  },
  async ({ keywords, location, language, limit }, { signal }) => {
    try {
      const { result, meta } = await run('keywords_data/google_ads/keywords_for_keywords/live', { keywords, sort_by: 'search_volume' }, { location, language }, 0.09, signal);
      const rows = result
        .filter((k) => k.keyword)
        .sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0))
        .slice(0, limit ?? 50)
        .map((k) => ({ keyword: k.keyword, search_volume: k.search_volume ?? null, competition: k.competition ?? null, cpc_usd: round(k.cpc) }));
      return asText({ ...meta, search_volume_is: 'average monthly searches over the last 12 months (Google Ads)', data_through: dataThrough(result), ideas_found: result.length, ideas: rows });
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  'seo_ranked_keywords',
  {
    description:
      'The Google searches a domain (or one page URL) ranks for, from DataForSEO Labs, highest search volume first: position, ranking page, monthly volume, keyword difficulty (0-100) and estimated traffic. ' +
      'Labs covers only some languages per country: Netherlands = "nl", United Kingdom = "en". About $0.01 per call plus $0.0001 per keyword.',
    inputSchema: {
      target: z.string().min(1).describe('A domain without https:// ("wakey.care") or a full page URL'),
      ...place,
      limit: z.number().int().min(1).max(200).optional().describe('How many keywords to return. Default 50.'),
    },
    annotations: READ,
  },
  async ({ target, location, language, limit }, { signal }) => {
    try {
      const { result, meta } = await run(
        'dataforseo_labs/google/ranked_keywords/live',
        { target, limit: limit ?? 50, order_by: ['keyword_data.keyword_info.search_volume,desc'] },
        { location, language },
        0.012 + 0.00012 * (limit ?? 50),
        signal,
      );
      const r = result[0] ?? {};
      const rows = (r.items ?? []).map((i: Item) => {
        const s = i.ranked_serp_element?.serp_item ?? {};
        return {
          keyword: i.keyword_data?.keyword,
          search_volume: i.keyword_data?.keyword_info?.search_volume ?? null,
          difficulty: i.keyword_data?.keyword_properties?.keyword_difficulty ?? null,
          position: s.rank_group ?? null,
          type: s.type ?? null,
          url: s.url ?? null,
          est_traffic: round(s.etv, 1),
          // Labs checks each ranking every few weeks or months: this is when.
          ranking_checked: String(i.ranked_serp_element?.last_updated_time ?? '').slice(0, 10) || null,
        };
      });
      return asText({ target, ...meta, total_keywords: r.total_count ?? 0, keywords: rows });
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  'seo_competitors',
  {
    description:
      'Domains that compete with a domain in Google, from DataForSEO Labs: how many searches they share, their average position, organic keyword count and estimated monthly traffic. ' +
      'Labs covers only some languages per country: Netherlands = "nl", United Kingdom = "en". About $0.01 per call.',
    inputSchema: {
      target: z.string().min(1).describe('A domain without https:// ("wakey.care")'),
      ...place,
      limit: z.number().int().min(1).max(50).optional().describe('How many competitors. Default 20.'),
    },
    annotations: READ,
  },
  async ({ target, location, language, limit }, { signal }) => {
    try {
      const { result, meta } = await run('dataforseo_labs/google/competitors_domain/live', { target, limit: (limit ?? 20) + 1 }, { location, language }, 0.012 + 0.00012 * ((limit ?? 20) + 1), signal);
      const r = result[0] ?? {};
      const bare = target.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      const rows = (r.items ?? [])
        .filter((i: Item) => String(i.domain).replace(/^www\./, '') !== bare)
        .slice(0, limit ?? 20)
        .map((i: Item) => ({
          domain: i.domain,
          shared_keywords: i.intersections ?? null,
          avg_position: round(i.avg_position, 1),
          organic_keywords: i.full_domain_metrics?.organic?.count ?? null,
          est_traffic: round(i.full_domain_metrics?.organic?.etv, 0),
        }));
      return asText({ target, ...meta, total_competitors: r.total_count ?? 0, competitors: rows });
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  'seo_page_audit',
  {
    description:
      'An on-page SEO check of one URL: status, title and description (with lengths), canonical, headings, word count, links, images, an on-page score (0-100) and the problems found. About $0.0002 per call.',
    inputSchema: { url: z.string().url().describe('The full page URL, https://…') },
    annotations: READ,
  },
  async ({ url }, { signal }) => {
    try {
      const { result, cost, spent, warning } = await paid('on_page/instant_pages', { url }, 0.0005, signal);
      const p = result[0]?.items?.[0];
      if (!p) return asError(`DataForSEO could not load ${url}.`);
      const m = p.meta ?? {};
      // Checks that are good news when true: false is the problem ("not_is_https").
      const good = new Set(['is_https', 'canonical', 'has_html_doctype', 'seo_friendly_url']);
      // Neutral facts, or not an SEO problem (an image title attribute; alt text is no_image_alt).
      const neutral = new Set(['is_www', 'has_meta_title', 'has_micromarkup', 'from_sitemap', 'is_redirect', 'no_image_title']);
      const problems = Object.entries(p.checks ?? {}).flatMap(([k, v]) => {
        if (good.has(k) || k.startsWith('seo_friendly_url_')) return v === false ? [`not_${k}`] : [];
        return v === true && !neutral.has(k) ? [k] : [];
      });
      return asText({
        url: p.url,
        status: p.status_code,
        ...(warning ? { warning } : {}),
        cost_usd: round(cost, 4),
        session_spent_usd: round(spent, 4),
        onpage_score: round(p.onpage_score, 1),
        title: m.title ?? null,
        title_length: m.title_length ?? null,
        description: m.description ?? null,
        description_length: m.description_length ?? null,
        canonical: m.canonical ?? null,
        h1: m.htags?.h1 ?? [],
        h2: (m.htags?.h2 ?? []).slice(0, 15).map((h: string) => h.replace(/\s+/g, ' ').trim()),
        words: m.content?.plain_text_word_count ?? null,
        internal_links: m.internal_links_count ?? null,
        external_links: m.external_links_count ?? null,
        images: m.images_count ?? null,
        structured_data: p.checks?.has_micromarkup ?? null,
        page_size_bytes: p.size ?? null,
        load_time_ms: p.page_timing?.duration_time ?? null,
        problems,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

await server.connect(new StdioServerTransport());
