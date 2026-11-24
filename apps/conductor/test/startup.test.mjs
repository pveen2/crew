import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test('local tokens rotate by default, fixed tokens survive restarts and bad server settings fail at startup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-startup-'));
  const env = { ...process.env, CREW_HOME: dir, CREW_PORT: '0' };
  for (const key of ['CREW_ACCESS_AUD', 'CREW_ACCESS_TEAM_DOMAIN', 'CREW_TOKEN', 'CREW_REQUIRE_ACCESS', 'CREW_TEAM_DIR']) delete env[key];
  const entry = 'apps/conductor/src/main.ts';
  const info = join(dir, 'conductor.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const extra of [{ CREW_TOKEN: '' }, { CREW_TOKEN: 'short' }, { CREW_ACCESS_AUD: 'partial' }, { CREW_REQUIRE_ACCESS: '1' }]) {
    const fail = spawnSync(process.execPath, [entry], { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.notEqual(fail.status, 0);
    assert.match(fail.stderr, /CREW_(TOKEN|ACCESS_TEAM_DOMAIN)/);
    assert.equal(existsSync(info), false);
  }

  async function start(extra) {
    const child = spawn(process.execPath, [entry], { env: { ...env, ...extra }, stdio: 'ignore' });
    const stopped = once(child, 'exit');
    try {
      for (let i = 0; i < 100 && !existsSync(info) && child.exitCode === null; i++) await delay(25);
      return JSON.parse(readFileSync(info, 'utf8')).token;
    } finally {
      child.kill('SIGTERM');
      await stopped;
    }
  }
  assert.notEqual(await start({}), await start({}));
  const CREW_TOKEN = 'fixed'.repeat(8);
  assert.equal(await start({ CREW_TOKEN }), CREW_TOKEN);
  assert.equal(await start({ CREW_TOKEN }), CREW_TOKEN);
});
