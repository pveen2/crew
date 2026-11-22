import type { Engine } from '@crew/protocol';
import { claudeCode } from './claude.ts';
import { codex } from './codex.ts';
import { antigravity } from './antigravity.ts';
import { grok } from './grok.ts';
import type { EngineAdapter } from './types.ts';

export const engines: Record<Engine, EngineAdapter> = {
  'claude-code': claudeCode,
  codex,
  grok,
  antigravity,
};

export type * from './types.ts';
