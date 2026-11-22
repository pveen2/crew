// A team folder may live in another repo (a brand's monorepo) that never
// installed Crew's packages. Its files import '@crew/sdk/define',
// '@crew/kit/shopify' or 'zod' all the same: when such a bare import cannot be
// found from where it is written, it is looked up again from Crew's own install
// (`base`), so a team needs nothing installed. Anything the team's repo does
// install still wins.

import { registerHooks } from 'node:module';

const RELATIVE = /^(\.{1,2}\/|\/|file:|node:|data:)/;

export function resolveTeamImportsFrom(base: string): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (RELATIVE.test(specifier) || (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND')) throw err;
        return nextResolve(specifier, { ...context, parentURL: base });
      }
    },
  });
}
