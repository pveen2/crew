// Google sign-in for a service account, without the googleapis package: a JWT
// signed with the account's private key (RS256, node:crypto), exchanged at
// Google's token endpoint for a one-hour access token, kept in memory only.
//
// The key comes from GOOGLE_SEARCH_CONSOLE_KEY: the service account's JSON key,
// as it is or base64-encoded. It is never written to disk, and no message here
// quotes any part of it (not even JSON.parse's, which echoes the input).

import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const KEY_VAR = 'GOOGLE_SEARCH_CONSOLE_KEY';

export interface ServiceAccountKey {
  clientEmail: string;
  keyId?: string;
  privateKey: KeyObject;
}

const SETUP_HINT = `Paste the service account's whole JSON key (or base64 of it) into ${KEY_VAR} in the Crew environment (Settings, or .env.local).`;

/** Reads the JSON key, as it is or base64-encoded. Throws a message that never contains the key. */
export function parseServiceAccountKey(raw: string | undefined): ServiceAccountKey {
  const text = raw?.trim() ?? '';
  if (!text) throw new Error(`Search Console is not set up: ${KEY_VAR} is empty. ${SETUP_HINT}`);
  const json = text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8').trim();
  let key: Record<string, unknown>;
  try {
    key = JSON.parse(json);
  } catch {
    throw new Error(`${KEY_VAR} is not a JSON key: it is neither JSON nor base64 of JSON. ${SETUP_HINT}`);
  }
  if (!key || typeof key !== 'object') throw new Error(`${KEY_VAR} is not a JSON key. ${SETUP_HINT}`);
  if (key.type !== 'service_account') {
    throw new Error(`${KEY_VAR} is not a service account key (type is ${JSON.stringify(key.type ?? null)}, expected "service_account"). Create a JSON key for a service account, not an OAuth client.`);
  }
  if (typeof key.client_email !== 'string' || !key.client_email.includes('@')) throw new Error(`${KEY_VAR} has no client_email. ${SETUP_HINT}`);
  if (typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) throw new Error(`${KEY_VAR} has no private_key. ${SETUP_HINT}`);
  let privateKey: KeyObject;
  try {
    // A key pasted through some shells keeps its newlines as the two characters \n.
    privateKey = createPrivateKey(key.private_key.replace(/\\n/g, '\n'));
  } catch {
    throw new Error(`${KEY_VAR}: the private_key could not be read. Download a fresh JSON key for ${key.client_email}.`);
  }
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error(`${KEY_VAR}: the private_key is not an RSA key.`);
  return { clientEmail: key.client_email, keyId: typeof key.private_key_id === 'string' ? key.private_key_id : undefined, privateKey };
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** The signed assertion for Google's token endpoint (RS256, one hour). */
export function signServiceAccountJwt(key: ServiceAccountKey, nowSec = Math.floor(Date.now() / 1000), scope = SEARCH_CONSOLE_SCOPE): string {
  const header = { alg: 'RS256', typ: 'JWT', ...(key.keyId ? { kid: key.keyId } : {}) };
  const claims = { iss: key.clientEmail, scope, aud: GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(input).end().sign(key.privateKey);
  return `${input}.${b64url(signature)}`;
}

/** Access tokens for one service account, cached in memory until a minute before they expire. */
export class GoogleServiceAccountAuth {
  private token?: { value: string; expiresAt: number };
  private pending?: Promise<string>;

  readonly key: ServiceAccountKey;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(key: ServiceAccountKey, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - 60_000) return this.token.value;
    // Parallel tool calls share one sign-in.
    this.pending ??= this.fetchToken().finally(() => (this.pending = undefined));
    return this.pending;
  }

  /** Forget the token (after Google refused it). */
  invalidate() {
    this.token = undefined;
  }

  private async fetchToken(): Promise<string> {
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signServiceAccountJwt(this.key, Math.floor(this.now() / 1000)) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string | { message?: string }; error_description?: string } | null;
    if (!res.ok || !body?.access_token) {
      const error = typeof body?.error === 'object' ? body.error?.message : body?.error;
      const why = [error, body?.error_description].filter(Boolean).join(': ') || `HTTP ${res.status}`;
      const hint = /invalid_grant|signature|account not found/i.test(why)
        ? ` The key for ${this.key.clientEmail} was refused: it may have been deleted or the service account disabled (create a new JSON key), or this server's clock is off.`
        : '';
      throw new Error(`Google sign-in failed (${why}).${hint}`);
    }
    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}
