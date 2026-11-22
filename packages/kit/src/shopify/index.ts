// Shopify for Crew teams: a read-only connection for agents, plus the GraphQL
// helper an approval-gated tool (like the store manager's shopify_mutate) uses.

export { shopifyConnection } from './connection.ts';
export { graphql, isMutation, isReadOnlyQuery, readScopes, writeScopes } from './cli.ts';
