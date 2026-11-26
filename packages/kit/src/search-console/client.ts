// A small client for the Google Search Console API, bound to one property.
// Reading only (scope webmasters.readonly). Setup problems come back as
// messages that say what the owner has to do, including which properties the
// service account can see when the configured one is not among them.

import { GoogleServiceAccountAuth, KEY_VAR } from './auth.ts';

export const WEBMASTERS_API = 'https://www.googleapis.com/webmasters/v3';
export const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

/**
 * The property as Search Console names it: `sc-domain:wakey.care` (a domain
 * property) or a URL prefix ending in `/` (`https://wakey.care/`; the slash is added).
 */
export function normalizeSite(site: string): string {
  const s = site.trim();
  const domain = /^sc-domain:([a-z0-9.-]+)$/i.exec(s);
  if (domain) return `sc-domain:${domain[1]!.toLowerCase()}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`Search Console site "${site}" is not a property: use sc-domain:example.com (a domain property) or https://example.com/ (a URL-prefix property).`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Search Console site "${site}" must start with sc-domain:, https:// or http://.`);
  if (url.search || url.hash) throw new Error(`Search Console site "${site}" must not have a query or #fragment.`);
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

/** Whether a page URL belongs to the property (a domain property covers every subdomain and both protocols). */
export function urlBelongsToSite(pageUrl: string, site: string): boolean {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (site.startsWith('sc-domain:')) {
    const domain = site.slice('sc-domain:'.length);
    return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
  }
  return url.href.startsWith(site);
}

export class SearchConsoleClient {
  readonly site: string;
  readonly auth: GoogleServiceAccountAuth;
  private readonly fetchImpl: typeof fetch;

  constructor(site: string, auth: GoogleServiceAccountAuth, fetchImpl: typeof fetch = fetch) {
    this.site = site;
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  /** POST /sites/{site}/searchAnalytics/query */
  searchAnalytics(body: Record<string, unknown>) {
    return this.siteCall<{ rows?: SearchAnalyticsRow[]; responseAggregationType?: string; metadata?: { first_incomplete_date?: string } }>(
      `${WEBMASTERS_API}/sites/${encodeURIComponent(this.site)}/searchAnalytics/query`,
      { method: 'POST', body },
    );
  }

  /** GET /sites/{site}/sitemaps */
  sitemaps() {
    return this.siteCall<{ sitemap?: Sitemap[] }>(`${WEBMASTERS_API}/sites/${encodeURIComponent(this.site)}/sitemaps`, { method: 'GET' });
  }

  /** POST urlInspection/index:inspect */
  inspect(inspectionUrl: string, languageCode = 'en-US') {
    return this.siteCall<{ inspectionResult?: Record<string, any> }>(INSPECT_URL, { method: 'POST', body: { inspectionUrl, siteUrl: this.site, languageCode } });
  }

  /** GET /sites: the properties this service account was added to. */
  async listSites(): Promise<{ siteUrl: string; permissionLevel: string }[]> {
    const r = await this.request<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(`${WEBMASTERS_API}/sites`, { method: 'GET' });
    return r.siteEntry ?? [];
  }

  /** A call for this property: permission errors are explained with the properties the account can see. */
  private async siteCall<T>(url: string, init: { method: string; body?: unknown }): Promise<T> {
    try {
      return await this.request<T>(url, init);
    } catch (err) {
      if (err instanceof GoogleApiError && (err.status === 403 || err.status === 404) && !err.serviceDisabled) {
        throw new Error(await this.explainNoAccess(err));
      }
      throw err;
    }
  }

  private async explainNoAccess(err: GoogleApiError): Promise<string> {
    const email = this.auth.key.clientEmail;
    const addUser = `In Search Console, open the property → Settings → Users and permissions → Add user, enter ${email} with permission Restricted (reading is enough).`;
    let sites: { siteUrl: string; permissionLevel: string }[];
    try {
      sites = await this.listSites();
    } catch {
      return `No access to Search Console property ${this.site} (${err.message}). ${addUser}`;
    }
    const match = sites.find((s) => s.siteUrl === this.site);
    if (match?.permissionLevel === 'siteUnverifiedUser') {
      return `The service account ${email} is listed on ${this.site} but the property is not verified for it (siteUnverifiedUser). Verify the property in Search Console, or add ${email} again from a verified owner's account.`;
    }
    if (match) return `Search Console refused the call for ${this.site} (${err.message}).`;
    if (!sites.length) return `The service account ${email} has no access to any Search Console property, so not to ${this.site}. ${addUser}`;
    return (
      `The service account ${email} has no access to ${this.site}. It can see: ${sites.map((s) => `${s.siteUrl} (${s.permissionLevel})`).join(', ')}. ` +
      `If one of these is the right property, set site in searchConsoleConnection to it exactly (domain properties look like sc-domain:example.com, URL-prefix properties like https://example.com/). Otherwise: ${addUser}`
    );
  }

  private async request<T>(url: string, init: { method: string; body?: unknown }, retried = false): Promise<T> {
    const token = await this.auth.accessToken();
    const res = await this.fetchImpl(url, {
      method: init.method,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401 && !retried) {
      this.auth.invalidate();
      return this.request<T>(url, init, true);
    }
    const body = (await res.json().catch(() => null)) as (T & { error?: GoogleErrorBody }) | null;
    if (!res.ok) throw new GoogleApiError(res.status, body?.error);
    if (!body) throw new Error(`Search Console: HTTP ${res.status} with no JSON body`);
    return body;
  }
}

interface GoogleErrorBody {
  code?: number;
  message?: string;
  status?: string;
  details?: { reason?: string }[];
  errors?: { reason?: string }[];
}

export class GoogleApiError extends Error {
  readonly status: number;
  readonly serviceDisabled: boolean;
  constructor(status: number, error?: GoogleErrorBody) {
    const raw = error?.message ?? `HTTP ${status}`;
    const reasons = [...(error?.details ?? []), ...(error?.errors ?? [])].map((d) => d.reason);
    const serviceDisabled = reasons.includes('SERVICE_DISABLED') || reasons.includes('accessNotConfigured') || /has not been used in project|is disabled/i.test(raw);
    let message = `Search Console: ${raw}`;
    if (serviceDisabled) {
      message = `The Google Search Console API is not enabled in the service account's Google Cloud project. Enable it (Google Cloud console → APIs & Services → Library → "Google Search Console API" → Enable), wait a few minutes and try again. Google said: ${raw}`;
    } else if (status === 429) {
      message = `Search Console quota reached (${raw}). URL inspection allows 2,000 calls a day and 600 a minute per property; wait and try again.`;
    } else if (status === 401) {
      message = `Search Console refused the access token (${raw}). Check that ${KEY_VAR} holds a current key.`;
    }
    super(message);
    this.status = status;
    this.serviceDisabled = serviceDisabled;
  }
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string | number;
  errors?: string | number;
  contents?: { type?: string; submitted?: string | number; indexed?: string | number }[];
}
