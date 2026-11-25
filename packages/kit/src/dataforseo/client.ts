// A small client for the DataForSEO API (https://api.dataforseo.com/v3, basic
// auth with the API login and API password from app.dataforseo.com → API
// Access). Live endpoints only: one task per call, the answer in the response.
//
// Every call costs money (cents per call). The connection keeps a per-session
// budget (CREW_DATAFORSEO_MAX_COST, USD) and refuses calls once it is spent.

export const DATAFORSEO_API = 'https://api.dataforseo.com/v3';

export interface DataForSeoAuth {
  login: string;
  password: string;
}

/** The sign-in from the environment: DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD. */
export function dataForSeoFromEnv(): DataForSeoAuth {
  const login = process.env.DATAFORSEO_LOGIN?.trim() ?? '';
  const password = process.env.DATAFORSEO_PASSWORD?.trim() ?? '';
  if (!login || !password) {
    throw new Error('DataForSEO is not set up: add DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to the Crew environment (Settings, or .env.local).');
  }
  return { login, password };
}

export interface TaskResult<T = Record<string, unknown>> {
  result: T[];
  cost: number;
  /** Set when DataForSEO returned results with a task error. */
  warning?: string;
}

/** POST one task to a live endpoint, e.g. `serp/google/organic/live/advanced`. */
export async function callDataForSeo<T = Record<string, unknown>>(
  auth: DataForSeoAuth,
  path: string,
  task: Record<string, unknown>,
): Promise<TaskResult<T>> {
  const res = await fetch(`${DATAFORSEO_API}/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${auth.login}:${auth.password}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify([task]),
    redirect: 'error',
    signal: AbortSignal.timeout(110_000),
  });
  const body = (await res.json().catch(() => null)) as {
    status_code?: number;
    status_message?: string;
    tasks?: { status_code?: number; status_message?: string; cost?: number; result?: T[] | null }[];
  } | null;
  if (!res.ok || !body) throw new Error(`DataForSEO: HTTP ${res.status}${body?.status_message ? ` ${body.status_message}` : ''}`);
  if (body.status_code !== 20000) throw new Error(`DataForSEO: ${body.status_message ?? body.status_code}`);
  const t = body.tasks?.[0];
  if (!t) throw new Error('DataForSEO: no task in the response');
  const cost = t.cost ?? 0;
  if (t.status_code !== 20000) {
    // Some task errors still carry billed, usable results (e.g. a partial SERP): keep both.
    if (t.result?.length) return { result: t.result, cost, warning: `${t.status_message ?? t.status_code} (results may be incomplete)` };
    throw new DataForSeoError(`DataForSEO: ${t.status_message ?? t.status_code}`, cost);
  }
  return { result: t.result ?? [], cost };
}

/** A failed task, with what DataForSEO charged for it (often 0). */
export class DataForSeoError extends Error {
  readonly cost: number;
  constructor(message: string, cost: number) {
    super(message);
    this.cost = cost;
  }
}
