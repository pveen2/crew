// Talking to the running conductor from scripts (crew CLI, evals).

import { readFileSync } from 'node:fs';
import type { ConductorInfo } from '@crew/protocol';
import { paths } from '@crew/conductor/config';

let assertion: string | undefined;
export function accessHeaders(): Record<string, string> {
  if (!process.argv.includes('--access-stdin')) return {};
  assertion ??= readFileSync(0, 'utf8').trim();
  if (!assertion) throw new Error('Expected a Cloudflare Access assertion on stdin.');
  return { 'cf-access-jwt-assertion': assertion };
}

export function conductor(): ConductorInfo {
  try {
    return JSON.parse(readFileSync(paths.info, 'utf8')) as ConductorInfo;
  } catch {
    console.error('\x1b[31mThe conductor is not running. Start it with: pnpm conductor\x1b[0m');
    process.exit(1);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const info = conductor();
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { ...accessHeaders(), authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const color = (n: number) => (s: string) => `\x1b[${n}m${s}\x1b[0m`;
export const cyan = color(36);
export const green = color(32);
export const red = color(31);
export const yellow = color(33);
