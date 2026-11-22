import { defineEval } from '@crew/sdk/evals';

export default defineEval({
  description: 'A question about public prices on the web goes to the web researcher and comes back as a sourced report.',
  input:
    'Wat kost het om een normaal pakket van Nederland naar Spanje te sturen met PostNL? Check ook Sendcloud en geef een schatting.',
  timeoutMinutes: 20,
  async test(t) {
    t.succeeded();
    t.delegatedTo('web-researcher');
    t.calledTool('save_artifact', { by: 'web-researcher' });
    t.check('GM reply stays short', t.answer.length < 600, { soft: true, detail: `${t.answer.length} characters` });
    await t.judge(
      'Gives concrete PostNL and Sendcloud prices for a parcel from the Netherlands to Spain, states the assumed weight and size, ' +
        'links the source for each price, and says that the list prices are not necessarily what the business pays. No invented numbers.',
    );
  },
});
