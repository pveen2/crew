// electron-builder afterPack hook: copies build/runtime (the built-in conductor,
// see build-runtime.mjs) into the app as Resources/runtime. Done here rather
// than with extraResources, which drops node_modules folders. Runs before
// signing, so the copied files are signed with the app. `cp -R` keeps the
// workspace symlinks relative.
const { execFileSync } = require('node:child_process');
const { existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  const source = join(__dirname, '..', 'build', 'runtime');
  if (!existsSync(join(source, 'node_modules'))) throw new Error('build/runtime is missing: run `pnpm build:runtime` first');
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const target = join(app, 'Contents', 'Resources', 'runtime');
  rmSync(target, { recursive: true, force: true });
  execFileSync('cp', ['-R', source, target]);
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) rmSync(join(target, file), { force: true });
};
