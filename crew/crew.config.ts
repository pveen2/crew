import { defineCrew } from '@crew/sdk/define';

// The team as a whole. Add `shopify: { store: 'your-store.myshopify.com' }` and
// give an agent `connections/shopify.ts` (shopifyConnection from @crew/kit/shopify)
// to work on a store; put brand documents in lib/brand/ (or set `brand`).
export default defineCrew({
  name: 'Crew',
});
