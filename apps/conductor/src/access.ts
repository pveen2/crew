// Cloudflare Access in front of the conductor (a team server). Access signs
// every request it lets through with a JWT in Cf-Access-Jwt-Assertion; when
// CREW_ACCESS_TEAM_DOMAIN and CREW_ACCESS_AUD are set, the conductor accepts
// only requests that carry a valid one, so the app token alone is not enough.
// Without them (a conductor on a Mac) nothing changes.

import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const TEAM_DOMAIN = process.env.CREW_ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const AUD = process.env.CREW_ACCESS_AUD?.trim();

export const accessEnabled = Boolean(TEAM_DOMAIN && AUD);
if (Boolean(TEAM_DOMAIN) !== Boolean(AUD)) {
  throw new Error('Set both CREW_ACCESS_TEAM_DOMAIN and CREW_ACCESS_AUD, or neither.');
}

let keys = new Map<string, KeyObject>();
let fetchedAt = 0;

async function loadKeys(): Promise<void> {
  // At most once a minute, so a flood of bad kids cannot hammer Cloudflare.
  if (Date.now() - fetchedAt < 60_000) return;
  fetchedAt = Date.now();
  const res = await fetch(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys: Array<{ kid: string } & Record<string, unknown>> };
  keys = new Map(body.keys.map((k) => [k.kid, createPublicKey({ key: k as never, format: 'jwk' })]));
}

function part(s: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** The signed-in person's email, or null when the request did not come through Access. */
export async function accessEmail(req: IncomingMessage): Promise<string | null> {
  const jwt = String(req.headers['cf-access-jwt-assertion'] ?? '');
  const [h, p, sig] = jwt.split('.');
  if (!h || !p || !sig) return null;
  try {
    const header = part(h);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    if (!keys.has(header.kid)) await loadKeys();
    const key = keys.get(header.kid);
    if (!key) return null;
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(key, Buffer.from(sig, 'base64url'));
    if (!ok) return null;
    const claims = part(p);
    const now = Date.now() / 1000;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(AUD)) return null;
    if (claims.iss !== `https://${TEAM_DOMAIN}`) return null;
    if (typeof claims.exp !== 'number' || claims.exp < now - 30) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now + 30) return null;
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}
