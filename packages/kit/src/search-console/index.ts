// Google Search Console for Crew teams: a read-only connection for one property
// (search performance, URL inspection, sitemaps), signed in as a service account.

export { searchConsoleConnection, SEARCH_CONSOLE_TOOLS } from './connection.ts';
export { parseServiceAccountKey, signServiceAccountJwt, GoogleServiceAccountAuth, SEARCH_CONSOLE_SCOPE, KEY_VAR } from './auth.ts';
export { SearchConsoleClient, normalizeSite, urlBelongsToSite } from './client.ts';
