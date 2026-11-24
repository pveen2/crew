import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

type SigningKey = JsonWebKey & { kid?: string; alg?: string; use?: string };
export type AccessIdentity = (assertion: string | string[] | undefined) => Promise<{ email: string; expiresAt: number } | null>;

export function accessIdentity(domain = process.env.CREW_ACCESS_TEAM_DOMAIN, aud = process.env.CREW_ACCESS_AUD): AccessIdentity | undefined {
  if (domain === undefined && aud === undefined) return;
  if (!domain || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/i.test(domain) || !aud?.trim()) {
    throw new Error('Set both CREW_ACCESS_TEAM_DOMAIN (the Cloudflare team hostname) and CREW_ACCESS_AUD.');
  }

  const issuer = 'https://' + domain.toLowerCase();
  let keys = new Map<string, KeyObject>();
  let expires = 0;
  let nextMiss = 0;
  let fetching: Promise<void> | undefined;
  async function refresh() {
    const res = await fetch(issuer + '/cdn-cgi/access/certs', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('Cannot load Cloudflare signing keys');
    const data = await res.json() as { keys: SigningKey[] };
    const fresh = new Map<string, KeyObject>();
    for (const jwk of data.keys) {
      if (jwk.kid && jwk.kty === 'RSA' && (!jwk.alg || jwk.alg === 'RS256') && (!jwk.use || jwk.use === 'sig')) {
        fresh.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      }
    }
    keys = fresh;
    expires = Date.now() + 60 * 60_000;
  }

  return async (assertion) => {
    if (typeof assertion !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(assertion)) return null;
    try {
      const [head, body, sig] = assertion.split('.');
      const { alg, kid } = JSON.parse(Buffer.from(head, 'base64url').toString());
      if (alg !== 'RS256' || typeof kid !== 'string' || !kid) return null;
      // Share fetches during rotation. Random key IDs must not cause a fetch per request.
      if (Date.now() >= expires || !keys.has(kid)) {
        if (!fetching && Date.now() >= nextMiss) {
          const unknown = expires > Date.now();
          nextMiss = Date.now() + 10_000;
          fetching = refresh().then(() => { if (!unknown) nextMiss = 0; }).finally(() => { fetching = undefined; });
        }
        await fetching;
      }
      const key = keys.get(kid);
      if (!key || Date.now() >= expires || !verify('RSA-SHA256', Buffer.from(head + '.' + body), key, Buffer.from(sig, 'base64url'))) return null;
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      const now = Date.now() / 1000;
      if (claims.iss !== issuer || !(Array.isArray(claims.aud) ? claims.aud.includes(aud) : claims.aud === aud)) return null;
      if (!Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))) return null;
      return typeof claims.email === 'string' && claims.email.trim() ? { email: claims.email, expiresAt: claims.exp * 1000 } : null;
    } catch {
      return null;
    }
  };
}
