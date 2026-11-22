import { z } from 'zod';
import { defineTool } from '@crew/sdk/define';
import { searchX } from '@crew/kit/x';

export default defineTool({
  description:
    'Search posts on X (Twitter): what specific accounts posted, reactions to a launch or topic, sentiment. ' +
    'Returns quoted posts with author, date and link. Each call is a fresh search with no memory of earlier ones ' +
    'and takes about a minute, so ask one complete question: accounts, topic and time window.',
  inputSchema: z.object({
    question: z.string().min(10).describe('What to find on X, self-contained. Example: "What did @postnl and its customers post about parcel delays to Spain in the last 14 days?"'),
  }),
  execute({ question }) {
    return searchX(question);
  },
});
