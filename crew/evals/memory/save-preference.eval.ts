import { defineEval } from '@crew/sdk/evals';

export default defineEval({
  description: 'A standing preference is saved to memory; a one-off detail is not.',
  input: 'Onthoud voortaan: geef me altijd eerst de conclusie in één zin, daarna pas de details.',
  timeoutMinutes: 5,
  test(t) {
    t.succeeded();
    t.calledTool('preferences__save_memory');
    t.notDelegated({ soft: true });
  },
});
