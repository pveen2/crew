import { z } from 'zod';
import { defineTool } from '@crew/sdk/define';

export default defineTool({
  description: 'Current date and time where the team works (TZ, default Europe/Amsterdam). Use for anything date-related.',
  inputSchema: z.object({}),
  execute() {
    const now = new Date();
    return {
      iso: now.toISOString(),
      local: now.toLocaleString('en-GB', { timeZone: process.env.TZ || 'Europe/Amsterdam', dateStyle: 'full', timeStyle: 'short' }),
    };
  },
});
