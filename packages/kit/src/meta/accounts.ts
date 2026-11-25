import type { EnvRef } from '@crew/sdk/define';
import { normAccount } from './guard.ts';

/**
 * The ad accounts an agent may use: a list in the team's code, or
 * fromEnv('NAME') for a comma-separated list in the Crew environment (read when
 * the agent runs, so the ids stay out of the repo).
 */
export type MetaAdAccounts = string[] | EnvRef;

export const isEnvRef = (v: MetaAdAccounts): v is EnvRef => !Array.isArray(v) && typeof v?.fromEnv === 'string';

export function checkAdAccounts(v: MetaAdAccounts | undefined, who: string): void {
  if (!v || (Array.isArray(v) ? !v.length : !isEnvRef(v) || !v.fromEnv.trim())) {
    throw new Error(`${who}: list the ad accounts the agent may use in adAccounts, or pass fromEnv('NAME')`);
  }
  if (isEnvRef(v) && v.fromEnv.startsWith('CREW_')) throw new Error(`${who}: CREW_ names are Crew's own; name the ad accounts variable something else`);
}

/** The ids now. Throws when the environment value is empty. */
export function resolveAdAccounts(v: MetaAdAccounts): string[] {
  const raw = isEnvRef(v) ? (process.env[v.fromEnv] ?? '').split(',') : v;
  const ids = raw.map(normAccount).filter(Boolean);
  if (!ids.length) {
    throw new Error(isEnvRef(v) ? `Meta Ads: no ad accounts are set for this agent. Add ${v.fromEnv} (comma-separated ad account ids) to the Crew environment.` : 'Meta Ads: no ad accounts are set for this agent.');
  }
  return ids;
}

/** For tool descriptions: the ids, or where they come from. */
export const describeAdAccounts = (v: MetaAdAccounts) =>
  isEnvRef(v) ? `the ad accounts in ${v.fromEnv}` : `ad account${v.length > 1 ? 's' : ''} ${v.join(', ')}`;
