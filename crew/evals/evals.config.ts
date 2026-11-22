import { defineEvalConfig } from '@crew/sdk/evals';

export default defineEvalConfig({
  // The judge runs on the owner's subscription too.
  judge: { model: 'claude-code/sonnet' },
  timeoutMinutes: 15,
});
