// Conductor entry point: `pnpm conductor` (or `pnpm dev` from the root).

import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { resolveTeamImportsFrom } from '@crew/sdk/resolve';
import type { ConductorInfo } from '@crew/protocol';
import { loadCrew } from '@crew/sdk/load';
import { ensureDirs, paths, port, sharedEngineHome } from './config.ts';
import { Store } from './db.ts';
import { Runtime } from './runtime.ts';
import { startServer } from './server.ts';
import { accessEnabled } from './access.ts';

// The team may sit in another repo without Crew's packages installed.
resolveTeamImportsFrom(import.meta.url);

ensureDirs();

// Fail early if the team definition is broken.
const crew = await loadCrew();

const store = new Store(paths.db);
const runtime = new Runtime(store);
const interrupted = runtime.recover();

// A server keeps one token across restarts (CREW_TOKEN); on a Mac it is new every start.
const fixedToken = process.env.CREW_TOKEN?.trim();
if (fixedToken !== undefined && fixedToken.length < 32) throw new Error('CREW_TOKEN must be at least 32 characters.');
const token = fixedToken || randomBytes(24).toString('base64url');
const server = await startServer(runtime, { port, token });

const info: ConductorInfo = { port, token, pid: process.pid, startedAt: Date.now() };
writeFileSync(paths.info, JSON.stringify(info, null, 2), { mode: 0o600 });

console.log(`Crew conductor on http://127.0.0.1:${port}`);
console.log(`  data:   ${paths.home}`);
if (accessEnabled) console.log('  access: Cloudflare Access login required on every request');
console.log(`  agents: ${Object.values(crew.agents).map((a) => `${a.name}${a.isLead ? ' (lead)' : ''} ${a.engine}/${a.model}`).join(', ')}`);
console.log(`  engine sign-in: ${sharedEngineHome ? 'SHARED with your personal ~/.claude and ~/.codex (dev mode)' : 'Crew\'s own (pnpm crew login claude|codex)'}`);
if (interrupted) console.log(`  marked ${interrupted} running turn(s) as interrupted after the restart`);

let stopping = false;
async function stop(signal: string) {
  if (stopping) process.exit(1);
  stopping = true;
  console.log(`\n${signal}: stopping running turns…`);
  // Never outlive whoever stopped us (the Mac app quits right after): turns get
  // 8 seconds in shutdown(), and anything that hangs after that is cut off.
  setTimeout(() => process.exit(0), 12_000).unref();
  await runtime.shutdown();
  server.close();
  rmSync(paths.info, { force: true });
  store.db.close();
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
