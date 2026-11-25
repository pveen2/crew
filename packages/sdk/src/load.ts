// Reads the team folder (agent/, lib/, evals/) into plain data. Used by the
// conductor, the crew CLI and the try and eval scripts. Files are re-imported
// on every call so the owner can edit agents without restarting anything.
//
// Discovery is by path, like eve: the lead is agent/, every folder in
// agent/subagents/ is a specialist, a tool's name is its file name, a skill's
// name is its folder. Subagents inherit nothing from the lead.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrandFont, Engine, Permissions } from '@crew/protocol';
import {
  kindOf,
  parseModel,
  type AgentDefinition,
  type CrewConfig,
  type ConnectionDefinition,
  type MemoryDefinition,
  type Reasoning,
  type SkillRef,
  type ToolDefinition,
} from './define.ts';

/**
 * The team folder: CREW_TEAM_DIR, otherwise crew/ in the folder pnpm was
 * started from (INIT_CWD, so `pnpm dev` from the repo root works although the
 * conductor runs in apps/conductor) or the current folder. The product and the
 * team live apart: a brand's monorepo keeps its team in crew/.
 */
export const TEAM_ROOT = resolve(
  process.env.CREW_TEAM_DIR?.trim() ||
    [process.env.INIT_CWD, process.cwd()].filter((d): d is string => Boolean(d)).map((d) => join(d, 'crew')).find((d) => existsSync(d)) ||
    join(process.cwd(), 'crew'),
);

export interface SkillDir {
  name: string;
  dir: string;
  description: string;
  /** Set when the skill comes from lib/skills through sharedSkill(). */
  shared: boolean;
}

export interface LoadedTool {
  name: string;
  file: string;
  description: string;
  approval?: 'user-approval';
}

export interface LoadedMemory {
  name: string;
  def: MemoryDefinition;
}

export interface LoadedAgent {
  name: string;
  label: string;
  dir: string;
  isLead: boolean;
  def: AgentDefinition;
  engine: Engine;
  model: string;
  reasoning?: Reasoning;
  permissions: Permissions;
  webAccess: boolean;
  description: string;
  instructions: string;
  skills: SkillDir[];
  tools: LoadedTool[];
  connections: Record<string, ConnectionDefinition>;
  memories: LoadedMemory[];
}

export interface LoadedCrew {
  root: string;
  /** crew.config.ts, with SHOPIFY_STORE applied. */
  config: CrewConfig & { name: string };
  /** Name of the lead agent. */
  lead: string;
  /** The lead first, then the subagents in folder order. */
  agents: Record<string, LoadedAgent>;
  /** Rules every agent gets (lib/rules.md): Crew's own system prompt. */
  rules: string;
  /** Copied read-only into each session's context/brand/: absolute `from`, `to` relative to context/brand/ ('' = its root). */
  brand: Array<{ from: string; to: string }>;
  /** crew.config.ts `fonts`, with `file` made absolute. */
  fonts: Array<BrandFont & { file: string }>;
  limits: { turnTimeoutMinutes: number; threadTurnTimeoutMinutes: number };
}

const NAME = /^[a-z][a-z0-9-]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

async function importDefault(file: string): Promise<unknown> {
  const url = pathToFileURL(file);
  url.searchParams.set('v', String(statSync(file).mtimeMs));
  const mod = (await import(url.href)) as { default?: unknown };
  if (mod.default === undefined) throw new Error(`${file} must have a default export`);
  return mod.default;
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
}

function listModules(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(f) && !f.startsWith('_'))
    .sort()
    .map((f) => join(dir, f));
}

/** Parse the YAML-ish frontmatter of a SKILL.md. Only name and description matter here. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function readSkill(dir: string, name: string, shared: boolean): SkillDir {
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) throw new Error(`Skill ${dir}: SKILL.md is missing`);
  const fm = parseFrontmatter(readFileSync(file, 'utf8'));
  if (fm.name && fm.name !== name) throw new Error(`Skill ${file}: frontmatter name "${fm.name}" must match folder "${name}"`);
  if (!fm.description) throw new Error(`Skill ${file}: frontmatter needs a description`);
  return { name, dir, description: fm.description, shared };
}

async function loadSkills(root: string, dir: string): Promise<SkillDir[]> {
  const skills = listDirs(dir).map((name) => readSkill(join(dir, name), name, false));
  for (const file of listModules(dir)) {
    const ref = (await importDefault(file)) as SkillRef;
    if (kindOf(ref) !== 'skill') throw new Error(`${file}: export default sharedSkill('<name>')`);
    const name = basename(file, '.ts');
    if (ref.shared !== name) throw new Error(`${file}: file name must match the shared skill "${ref.shared}"`);
    const sharedDir = join(root, 'lib', 'skills', name);
    if (!existsSync(sharedDir)) throw new Error(`${file}: no shared skill lib/skills/${name}`);
    skills.push(readSkill(sharedDir, name, true));
  }
  const seen = new Set<string>();
  for (const s of skills) {
    if (seen.has(s.name)) throw new Error(`${dir}: skill "${s.name}" is defined twice`);
    seen.add(s.name);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Crew's own tools (MCP server `crew`). A team tool or subagent with one of these names would clash with it. */
export const CREW_TOOL_NAMES = ['rename_thread', 'ask_owner', 'show_preview', 'save_artifact', 'read_artifact', 'list_docs', 'approve'];

async function loadTools(dir: string): Promise<LoadedTool[]> {
  const tools: LoadedTool[] = [];
  for (const file of listModules(dir)) {
    const name = basename(file, '.ts');
    if (!TOOL_NAME.test(name)) throw new Error(`${file}: tool file names are snake_case`);
    if (CREW_TOOL_NAMES.includes(name)) throw new Error(`${file}: "${name}" is one of Crew's own tools; pick another name`);
    const def = (await importDefault(file)) as ToolDefinition;
    if (kindOf(def) !== 'tool') throw new Error(`${file}: export default defineTool({...})`);
    tools.push({ name, file, description: def.description, approval: def.approval });
  }
  return tools;
}

async function loadConnections(dir: string): Promise<Record<string, ConnectionDefinition>> {
  const out: Record<string, ConnectionDefinition> = {};
  for (const file of listModules(dir)) {
    const name = basename(file, '.ts');
    if (!TOOL_NAME.test(name)) throw new Error(`${file}: connection file names are snake_case`);
    const def = await importDefault(file);
    if (kindOf(def) !== 'connection') throw new Error(`${file}: export default defineConnection({...}) or a lib/ factory`);
    out[name] = def as ConnectionDefinition;
  }
  return out;
}

async function loadMemories(dir: string): Promise<LoadedMemory[]> {
  const out: LoadedMemory[] = [];
  for (const file of listModules(dir)) {
    const name = basename(file, '.ts');
    if (!TOOL_NAME.test(name)) throw new Error(`${file}: memory file names are snake_case`);
    const def = await importDefault(file);
    if (kindOf(def) !== 'memory') throw new Error(`${file}: export default defineMemory({...})`);
    out.push({ name, def: def as MemoryDefinition });
  }
  return out;
}

function sentenceCase(name: string): string {
  const s = name.replace(/-/g, ' ');
  return s.length <= 3 ? s.toUpperCase() : s[0]!.toUpperCase() + s.slice(1);
}

async function loadAgent(root: string, dir: string, name: string, isLead: boolean): Promise<LoadedAgent> {
  const agentFile = join(dir, 'agent.ts');
  const where = relative(root, agentFile);
  const def = (await importDefault(agentFile)) as AgentDefinition;
  if (kindOf(def) !== 'agent') throw new Error(`${where}: export default defineAgent({...})`);
  if (!isLead && def.name && def.name !== name) throw new Error(`${where}: a subagent is named by its folder; remove name "${def.name}"`);
  if (!isLead && !def.description) throw new Error(`${where}: a subagent needs a description (the lead reads it to decide whom to call)`);
  if (!isLead && def.limits) throw new Error(`${where}: limits belong on the lead (agent/agent.ts)`);
  const permissions = def.permissions ?? 'read-only';
  if (permissions !== 'read-only' && permissions !== 'draft') {
    throw new Error(`${where}: the trial allows only 'read-only' or 'draft' permissions`);
  }
  const { engine, model, reasoning } = parseModel(def.model);

  const instructions = readText(join(dir, 'instructions.md'));
  if (!instructions) throw new Error(`${relative(root, dir) || 'agent'}/instructions.md is required`);

  const connections = await loadConnections(join(dir, 'connections'));
  return {
    name,
    label: def.label ?? sentenceCase(name),
    dir,
    isLead,
    def,
    engine,
    model,
    reasoning,
    permissions,
    webAccess: def.webAccess ?? Object.keys(connections).length === 0,
    description: def.description ?? '',
    instructions,
    skills: await loadSkills(root, join(dir, 'skills')),
    tools: await loadTools(join(dir, 'tools')),
    connections,
    memories: await loadMemories(join(dir, 'memory')),
  };
}

export async function loadCrew(root: string = TEAM_ROOT): Promise<LoadedCrew> {
  const leadDir = join(root, 'agent');
  if (!existsSync(join(leadDir, 'agent.ts'))) throw new Error(`${leadDir}/agent.ts is missing`);
  const leadDef = (await importDefault(join(leadDir, 'agent.ts'))) as AgentDefinition;
  const leadName = leadDef.name ?? 'lead';
  if (!NAME.test(leadName)) throw new Error(`agent/agent.ts: name "${leadName}" must be kebab-case`);

  const agents: Record<string, LoadedAgent> = {};
  agents[leadName] = await loadAgent(root, leadDir, leadName, true);
  for (const name of listDirs(join(leadDir, 'subagents'))) {
    if (!NAME.test(name)) throw new Error(`agent/subagents/${name}: folder names are kebab-case`);
    if (name === leadName) throw new Error(`agent/subagents/${name}: has the same name as the lead`);
    if (CREW_TOOL_NAMES.includes(subagentToolName(name))) throw new Error(`agent/subagents/${name}: its tool name clashes with one of Crew's own tools; rename the folder`);
    agents[name] = await loadAgent(root, join(leadDir, 'subagents', name), name, false);
  }

  const configFile = join(root, 'crew.config.ts');
  const raw = existsSync(configFile) ? ((await importDefault(configFile)) as CrewConfig) : {};
  const store = process.env.SHOPIFY_STORE?.trim() || raw.shopify?.store;
  const config = { ...raw, name: raw.name?.trim() || 'Crew', shopify: store ? { store } : undefined };

  return {
    root,
    config,
    lead: leadName,
    agents,
    rules: readText(join(root, 'lib', 'rules.md')),
    brand: brandSources(root, raw.brand),
    fonts: brandFonts(root, raw.fonts),
    limits: {
      turnTimeoutMinutes: leadDef.limits?.turnTimeoutMinutes ?? 20,
      threadTurnTimeoutMinutes: leadDef.limits?.threadTurnTimeoutMinutes ?? 45,
    },
  };
}

function brandSources(root: string, brand: CrewConfig['brand']): LoadedCrew['brand'] {
  const entries = brand === undefined ? [join('lib', 'brand')] : Array.isArray(brand) ? brand : [brand];
  return entries.map((e) => {
    const from = resolve(root, typeof e === 'string' ? e : e.from);
    if (typeof e !== 'string') return { from, to: e.to };
    // A folder's contents go to the root of context/brand/; a file keeps its name.
    return { from, to: existsSync(from) && statSync(from).isDirectory() ? '' : basename(from) };
  });
}

function brandFonts(root: string, fonts: CrewConfig['fonts']): LoadedCrew['fonts'] {
  return (['text', 'accent'] as const).flatMap((role) => {
    const f = fonts?.[role];
    if (!f) return [];
    if (!f.family?.trim() || !f.file) throw new Error(`crew.config.ts: fonts.${role} needs a family and a file`);
    if (!/\.(woff2?|otf|ttf)$/i.test(f.file)) throw new Error(`crew.config.ts: fonts.${role}.file must be woff2, woff, otf or ttf`);
    return [{ role, family: f.family.trim(), weight: f.weight, style: f.style, file: resolve(root, f.file) }];
  });
}

/** Tool name the lead uses to call a subagent: its folder name in snake_case. */
export function subagentToolName(name: string): string {
  return name.replace(/-/g, '_');
}

/** All eval files under evals/, with their id (path without .eval.ts). */
export function listEvalFiles(root: string = TEAM_ROOT): Array<{ id: string; file: string }> {
  const base = join(root, 'evals');
  const out: Array<{ id: string; file: string }> = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')) walk(p);
      else if (e.isFile() && e.name.endsWith('.eval.ts')) out.push({ id: relative(base, p).replace(/\.eval\.ts$/, ''), file: p });
    }
  };
  walk(base);
  return out;
}
