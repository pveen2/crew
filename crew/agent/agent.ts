import { defineAgent } from '@crew/sdk/define';

// The lead. Every new thread lands here; it routes to one specialist in
// agent/subagents/ (or answers itself) and hands the work back.
export default defineAgent({
  name: 'gm',
  label: 'GM',
  description: 'General manager. Owns every thread, routes the work to the right specialist and hands it back.',
  model: 'claude-code/opus@medium',
  permissions: 'read-only',
  // Forgetting a standing preference is a change the owner should see.
  approval: ({ toolName }) => (toolName === 'preferences__remove_memory' ? 'user-approval' : undefined),
  limits: {
    turnTimeoutMinutes: 20,
    threadTurnTimeoutMinutes: 45,
  },
});
