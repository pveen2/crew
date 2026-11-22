// Starts the Vite dev server for the renderer, then Electron pointing at it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const server = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).pathname });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`renderer on ${url}`);

// Some hosts (other Electron apps, IDE terminals) set this, which turns Electron into plain Node.
const env = { ...process.env, CREW_RENDERER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;

const electron = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
electron.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
