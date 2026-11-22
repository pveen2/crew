// Builds build/runtime/: the conductor, the packages it and a team need, and
// the example team, with production dependencies installed. electron-builder
// copies it into the app as Resources/runtime, and the installed app runs the
// conductor from there on its own built-in Node (see electron/main.cjs).
//
// Same layout as the repo (apps/conductor, packages/*, crew), so the conductor
// runs from its TypeScript sources unchanged. Workspace packages are symlinked
// into node_modules; Node follows the links to packages/, outside any
// node_modules folder, where it may strip TypeScript types.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(repo, 'apps/mac/build/runtime');

const copies = ['apps/conductor', 'packages/protocol', 'packages/sdk', 'packages/kit', 'crew'];
const skip = /(^|\/)(node_modules|\.turbo|dist|tsconfig\.json)$/;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of copies) {
  cpSync(join(repo, dir), join(out, dir), { recursive: true, filter: (src) => !skip.test(src) });
}

writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'crew-runtime', private: true, type: 'module' }, null, 2) + '\n');
writeFileSync(join(out, 'pnpm-workspace.yaml'), ['packages:', ...copies.map((d) => `  - ${d}`), ''].join('\n'));
// A flat node_modules (no .pnpm store) is simpler to ship inside an app bundle.
writeFileSync(join(out, '.npmrc'), 'node-linker=hoisted\n');

execFileSync('pnpm', ['install', '--prod', '--ignore-scripts', '--no-frozen-lockfile', '--config.confirmModulesPurge=false'], {
  cwd: out,
  stdio: 'inherit',
});
rmSync(join(out, '.npmrc'));
console.log(`runtime ready in ${out}`);
