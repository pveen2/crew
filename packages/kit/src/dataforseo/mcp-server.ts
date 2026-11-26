// Read-only DataForSEO MCP server (stdio). Started by the agent CLI through
// connection.ts (dataForSeoConnection). Ten tools over DataForSEO's live
// endpoints, each trimmed to what an SEO or GEO answer needs: DataForSEO's raw
// responses are far too large for an agent's context. The seo_* tools cover
// Google search; the geo_* tools cover visibility in AI answers.
//
// Coverage differs per data source (checked 25 November 2026):
// - SERP and Google Ads keyword data: any country and language.
// - DataForSEO Labs (a domain's rankings, competitors): a few languages per
//   country only, e.g. Netherlands = Dutch, United Kingdom = English.
// - LLM Mentions (geo_llm_mentions, geo_mentions_summary; checked 26 November
//   2026): ChatGPT answers for United States / English only; Google AI
//   Overview answers for a limited set of country and language pairs.
//   Recorded answers, not live.
// - LLM Responses (geo_ask_llm): live, any prompt; the web search can be
//   pointed at a country (not for Gemini).
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
    if (path.startsWith('ai_optimization/llm_mentions/') && /language|location/i.test(msg)) {
      throw new Error(`${msg.replace(/\.+$/, '')}. LLM Mentions has Google AI Overview answers for a limited set of country and language pairs, and ChatGPT answers for United States / English only. Retry with another language for the country (e.g. Netherlands "nl", Belgium "nl" or "fr"), or with location "United States" and language "en".`);
    }
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

// --- GEO: visibility in AI answers (DataForSEO AI Optimization API) ---------
//
// LLM Mentions is a database of recorded AI answers (Google AI Overviews and
// ChatGPT), refreshed on a 60-day cycle: $0.10 per call plus $0.001 per row.
// ChatGPT data is United States / English only; Google AI Overview data covers
// a limited set of country and language pairs. LLM Responses asks a model live:
// $0.0006 plus what the model's provider charges (tokens and web search).

/** "wakey.care" from "https://www.wakey.care/x". */
const bareDomain = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');

/** Answer text without images, Google redirect noise and text-fragment anchors. */
const cleanAnswer = (s: unknown) =>
  typeof s === 'string'
    ? s
        .replace(/!\[[^\]]*\]\([^)]*\)\n?/g, '')
        .replace(/#:~:text=[^)\s]*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : null;

/** True when `host` is `domain` or one of its subdomains. */
const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

const cleanUrl = (u: unknown) => (typeof u === 'string' ? u.replace(/#:~:text=.*$/, '') : null);

/** Up to `max` characters around the first mention of one of `terms`, else the start. */
function excerpt(text: string | null, terms: string[], max: number): string | null {
  if (!text) return null;
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  const hit = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (hit === undefined) return `${text.slice(0, max)}…`;
  const start = Math.max(0, hit - Math.floor(max / 3));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + max)}${start + max < text.length ? '…' : ''}`;
}

const geoTarget = {
  domain: z.string().optional().describe('A domain without https:// ("wakey.care"): finds answers that cite or mention it.'),
  keyword: z.string().max(250).optional().describe('A brand or phrase ("wakey", "morning routine"): finds answers whose question or answer contains it.'),
  scope: z
    .enum(['any', 'sources', 'answer', 'question', 'brands'])
    .optional()
    .describe(
      'Where to look. For a domain: "any" (default) or "sources" (only answers that cite it). ' +
        'For a keyword: "any" (default), "answer", "question" or "brands" (named as a brand in the answer; ChatGPT data only).',
    ),
};

const geoPlace = {
  platform: z
    .enum(['google', 'chat_gpt'])
    .optional()
    .describe('"google" = Google AI Overviews (default), "chat_gpt" = ChatGPT. ChatGPT data exists for United States / English only; this tool then uses that location.'),
  location: z.string().optional().describe(`Country name or numeric location code. Default: ${LOCATION}. Ignored for chat_gpt (always United States).`),
  language: z.string().optional().describe(`Language code ("en", "nl"). Default: ${LANGUAGE}. Not every country has every language: if a call is rejected, try the country's own language.`),
};

/** The `target` array for LLM Mentions, from a domain and/or keyword. */
function mentionTarget(domain: string | undefined, keyword: string | undefined, scope: string | undefined): Item[] {
  const t: Item[] = [];
  if (domain?.trim()) t.push({ domain: bareDomain(domain), include_subdomains: true, search_scope: [scope === 'sources' ? 'sources' : 'any'] });
  if (keyword?.trim()) {
    const ks = scope === 'answer' || scope === 'question' ? scope : scope === 'brands' ? 'brand_entities' : 'any';
    t.push({ keyword: keyword.trim(), search_scope: [ks] });
  }
  if (!t.length) throw new Error('Give a domain, a keyword, or both.');
  return t;
}

const mentionPlace = (platform: string | undefined, location?: string, language?: string) =>
  platform === 'chat_gpt' ? { location: 'United States', language: 'en' } : { location, language };

server.registerTool(
  'geo_llm_mentions',
  {
    description:
      'Recorded AI answers that mention or cite a domain or brand, from DataForSEO\'s LLM Mentions database (Google AI Overviews, or ChatGPT): the question asked, ' +
      'an excerpt of the answer around the mention, the sources it cited, brands named next to it (ChatGPT only) and the question\'s AI search volume. Highest volume first. ' +
      'Coverage: ChatGPT = United States / English only; Google AI Overviews = a limited set of countries and languages (answers are recorded, refreshed over about 60 days, not live). ' +
      'About $0.10 per call plus $0.001 per answer returned.',
    inputSchema: {
      ...geoTarget,
      ...geoPlace,
      limit: z.number().int().min(1).max(50).optional().describe('How many answers to return. Default 10.'),
    },
    annotations: READ,
  },
  async ({ domain, keyword, scope, platform, location, language, limit }, { signal }) => {
    try {
      const n = limit ?? 10;
      const { result, meta } = await run(
        'ai_optimization/llm_mentions/search/live',
        { target: mentionTarget(domain, keyword, scope), platform: platform ?? 'google', limit: n, order_by: ['ai_search_volume,desc'] },
        mentionPlace(platform, location, language),
        0.1 + 0.001 * n,
        signal,
      );
      const r = result[0] ?? {};
      const terms = [keyword?.trim(), domain ? bareDomain(domain) : undefined, domain ? bareDomain(domain).split('.')[0] : undefined].filter((t): t is string => !!t);
      const own = domain ? bareDomain(domain) : null;
      const answers = (r.items ?? []).map((i: Item) => {
        const sources = (i.sources ?? []) as Item[];
        return {
          question: i.question ?? null,
          model: i.model_name ?? null,
          ai_search_volume: i.ai_search_volume ?? null,
          answer_excerpt: excerpt(cleanAnswer(i.answer), terms, 700),
          ...(own ? { cites_domain: sources.some((s) => onDomain(bareDomain(String(s.domain ?? s.url ?? '')), own)) } : {}),
          sources: sources.slice(0, 8).map((s) => ({ domain: s.domain ?? null, title: clip(s.title, 120), url: cleanUrl(s.url) })),
          ...(Array.isArray(i.brand_entities) && i.brand_entities.length ? { brands_named: i.brand_entities.map((b: Item) => b.title).filter(Boolean).slice(0, 15) } : {}),
          answer_recorded: String(i.last_response_at ?? '').slice(0, 10) || null,
        };
      });
      return asText({
        target: { domain: own, keyword: keyword ?? null, scope: scope ?? 'any' },
        platform: platform ?? 'google',
        ...meta,
        source: 'DataForSEO LLM Mentions (recorded answers, not live)',
        total_answers_found: r.total_count ?? 0,
        answers,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  'geo_mentions_summary',
  {
    description:
      'Totals for how often a domain or brand appears in recorded AI answers, from DataForSEO\'s LLM Mentions database: mention count and the AI search volume behind those answers, ' +
      'split by platform, the domains most cited as sources in those answers, and (ChatGPT only) the brands and brand categories named alongside. ' +
      'Leave platform empty for Google AI Overviews and ChatGPT together. Coverage: ChatGPT = United States / English only; Google AI Overviews = a limited set of countries and languages. About $0.10 per call.',
    inputSchema: {
      ...geoTarget,
      platform: z.enum(['google', 'chat_gpt']).optional().describe('"google" (AI Overviews) or "chat_gpt". Default: both (ChatGPT only counts for United States / English).'),
      location: geoPlace.location,
      language: geoPlace.language,
      top: z.number().int().min(1).max(20).optional().describe('How many top source domains and brands to list. Default 10.'),
    },
    annotations: READ,
  },
  async ({ domain, keyword, scope, platform, location, language, top }, { signal }) => {
    try {
      const { result, meta } = await run(
        'ai_optimization/llm_mentions/target_metrics/live',
        { target: mentionTarget(domain, keyword, scope), ...(platform ? { platform } : {}), internal_list_limit: top ?? 10 },
        mentionPlace(platform, location, language),
        0.102,
        signal,
      );
      const a = result[0]?.aggregated_metrics ?? result[0] ?? {};
      const group = (g: unknown) => (Array.isArray(g) ? g.map((x: Item) => ({ key: x.key, mentions: x.mentions ?? 0, ai_search_volume: x.ai_search_volume ?? null })) : []);
      return asText({
        target: { domain: domain ? bareDomain(domain) : null, keyword: keyword ?? null, scope: scope ?? 'any' },
        platform: platform ?? 'google + chat_gpt',
        ...meta,
        source: 'DataForSEO LLM Mentions (recorded answers, not live)',
        mentions_are: 'recorded AI answers that match the target; ai_search_volume = estimated monthly AI searches behind those answers',
        total: { mentions: a.total?.mentions ?? 0, ai_search_volume: a.total?.ai_search_volume ?? null },
        by_platform: group(a.platform),
        by_language: group(a.language),
        top_cited_domains: group(a.sources_domain),
        brands_named_alongside: group(a.brand_entities_title),
        brand_categories: group(a.brand_entities_category),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  'geo_ai_search_volume',
  {
    description:
      'AI search volume for up to 200 keywords: DataForSEO\'s estimate of how often each keyword is used in questions to AI tools in a country (last month, plus a 12-month trend). ' +
      'An estimate built from Google "People also ask" data, not counts from ChatGPT; compare keywords with each other rather than reading it as real traffic. About $0.01 per call plus $0.0001 per keyword: batch them.',
    inputSchema: {
      keywords: z.array(z.string().min(1).max(250)).min(1).max(200).describe('Keywords or short questions'),
      ...place,
    },
    annotations: READ,
  },
  async ({ keywords, location, language }, { signal }) => {
    try {
      const { result, meta } = await run('ai_optimization/ai_keyword_data/keywords_search_volume/live', { keywords }, { location, language }, 0.01 + 0.0001 * keywords.length, signal);
      const items = (result[0]?.items ?? []) as Item[];
      const series = (k: Item) => (Array.isArray(k.ai_monthly_searches) ? k.ai_monthly_searches : []);
      const newest = items.map(series).find((m) => m.length)?.[0];
      return asText({
        ...meta,
        source: 'DataForSEO AI Keyword Data',
        ai_search_volume_is: 'estimated monthly uses of the keyword in questions to AI tools (DataForSEO model, from Google People also ask data)',
        data_through: newest ? `${newest.year}-${String(newest.month).padStart(2, '0')}` : null,
        keywords: items
          .sort((x, y) => (y.ai_search_volume ?? 0) - (x.ai_search_volume ?? 0))
          .map((k) => ({
            keyword: k.keyword,
            ai_search_volume: k.ai_search_volume ?? null,
            monthly: series(k).slice(0, 12).map((m: Item) => `${m.year}-${String(m.month).padStart(2, '0')}: ${m.ai_search_volume ?? '?'}`),
          })),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

/** Default model per assistant: cheap, current, with web search. */
const LLM_DEFAULTS = { chat_gpt: 'gpt-5-mini', gemini: 'gemini-2.5-flash', claude: 'claude-haiku-4-5', perplexity: 'sonar' } as const;

/** ISO country codes for the web search, from the location name. */
const COUNTRY_ISO: Record<string, string> = {
  netherlands: 'NL', belgium: 'BE', germany: 'DE', france: 'FR', 'united kingdom': 'GB', 'united states': 'US', spain: 'ES', italy: 'IT',
  austria: 'AT', switzerland: 'CH', denmark: 'DK', sweden: 'SE', norway: 'NO', finland: 'FI', poland: 'PL', portugal: 'PT', ireland: 'IE', luxembourg: 'LU',
};

server.registerTool(
  'geo_ask_llm',
  {
    description:
      'Ask one AI assistant (ChatGPT, Gemini, Claude or Perplexity) a prompt live through DataForSEO, with web search on, and get its answer (trimmed), the URLs it cited and the searches it ran. ' +
      'Optionally checks which of the given brands or domains the answer names or cites. One run is one sample: answers vary between runs. ' +
      'About $0.01-0.08 per call (DataForSEO $0.0006 plus the model\'s own token and web-search price).',
    inputSchema: {
      prompt: z.string().min(1).max(500).describe('The question, as a shopper would ask it (max 500 characters)'),
      assistant: z.enum(['chat_gpt', 'gemini', 'claude', 'perplexity']).describe('Which assistant to ask'),
      model: z
        .string()
        .optional()
        .describe(`Model name, to override the default (${Object.entries(LLM_DEFAULTS).map(([k, v]) => `${k}: ${v}`).join(', ')}).`),
      country: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .optional()
        .describe('ISO country code the web search runs from ("NL", "BE", "DE", "GB", "US"). Default: from the connection\'s location. Not used by Gemini.'),
      look_for: z.array(z.string().min(1)).max(10).optional().describe('Brands or domains to check in the answer, e.g. ["wakey", "wakey.care", "loop earplugs"]'),
    },
    annotations: READ,
  },
  async ({ prompt, assistant, model, country, look_for }, { signal }) => {
    try {
      const model_name = model?.trim() || LLM_DEFAULTS[assistant];
      const iso = (country ?? COUNTRY_ISO[LOCATION.toLowerCase()] ?? '').toUpperCase();
      const task: Item = { user_prompt: prompt, model_name, max_output_tokens: 2048 };
      if (assistant !== 'perplexity') task.web_search = true;
      if (iso && assistant !== 'gemini') task.web_search_country_iso_code = iso;
      const { result, cost, spent, warning } = await paid(`ai_optimization/${assistant}/llm_responses/live`, task, 0.08, signal);
      const r = result[0] ?? {};
      const messages = ((r.items ?? []) as Item[]).filter((i) => i.type === 'message');
      const sections = messages.flatMap((m) => (m.sections ?? []) as Item[]);
      const text = sections.map((s) => s.text ?? '').join('\n').trim();
      const seen = new Set<string>();
      const cited = sections
        .flatMap((s) => (s.annotations ?? []) as Item[])
        .map((a) => ({ title: clip(a.title, 120), url: cleanUrl(a.direct_url ?? a.url) }))
        .filter((a) => a.url && !seen.has(a.url) && (seen.add(a.url), true))
        .slice(0, 20);
      const fanOut = [...new Set(sections.flatMap((s) => (Array.isArray(s.fan_out_queries) ? s.fan_out_queries : [])))].slice(0, 10);
      const lower = text.toLowerCase();
      const checks = (look_for ?? []).map((t) => {
        const term = t.trim().toLowerCase();
        const dom = term.includes('.') ? bareDomain(term) : null;
        return {
          term: t,
          named_in_answer: lower.includes(dom ?? term),
          ...(dom ? { cited: cited.some((c) => onDomain(bareDomain(String(c.url)), dom)) } : {}),
        };
      });
      return asText({
        assistant,
        model: r.model_name ?? model_name,
        prompt,
        web_search: r.web_search ?? null,
        web_search_country: assistant === 'gemini' ? null : iso || null,
        answered_at: r.datetime ?? null,
        ...(warning ? { warning } : {}),
        cost_usd: round(cost, 4),
        session_spent_usd: round(spent, 4),
        session_limit_usd: MAX_COST,
        source: 'DataForSEO LLM Responses (live, through the model\'s API; consumer apps may answer differently)',
        ...(checks.length ? { look_for: checks } : {}),
        answer: clip(text, 4000),
        cited_urls: cited,
        ...(fanOut.length ? { searches_run: fanOut } : {}),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

await server.connect(new StdioServerTransport());
