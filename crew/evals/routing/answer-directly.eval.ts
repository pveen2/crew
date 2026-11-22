import { defineEval } from '@crew/sdk/evals';

export default defineEval({
  description: 'A small question the GM can answer itself does not cost a handoff.',
  input: 'Welke dag is het vandaag?',
  timeoutMinutes: 5,
  test(t) {
    t.succeeded();
    t.notDelegated();
    t.calledTool('current_time', { soft: true });
  },
});
