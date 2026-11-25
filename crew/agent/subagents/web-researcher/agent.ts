import { defineAgent } from '@crew/sdk/define';

export default defineAgent({
  label: 'Web researcher',
  description:
    'Owns research on the public web and on X (Twitter): finds, reads and compares pages (prices, suppliers, competitors, rules, how-tos), can fill in public forms and calculators, can search what people post on X, can keep screenshots of what a page shows (ads, product photos) so a document can show them, and returns a sourced report. Ask it for screenshots of images, not image URLs. Has no store data: give it the store facts it needs.',
  model: 'claude-code/sonnet@high',
  permissions: 'read-only',
  // It has a connection (the browser) but no store or customer data, so it keeps web search and fetch.
  webAccess: true,
});
