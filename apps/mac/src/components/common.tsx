import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Face, FaceStack, type FaceSize } from '@crew/ui';
import type { Usage } from '@crew/protocol';
import { personName, setScope, useApp, type Scope } from '../store';

marked.setOptions({ gfm: true, breaks: false });

/**
 * Agent-written Markdown is untrusted. Allow document formatting only: no inline
 * styles, classes, ids, forms, media or embeds, so an answer cannot restyle or
 * imitate the app's own controls. HTML documents go to the sandboxed preview iframe.
 */
const MARKDOWN_POLICY = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'mark',
  ],
  ALLOWED_ATTR: ['href', 'title', 'start', 'align', 'colspan', 'rowspan'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
};

// Links in agent text always open in the system browser (main process), never in the app window.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Puts each table in its own scroll box, so a wide one never scrolls the pane. Done on the DOM, not the string, so text that looks like a tag is left alone. */
function wrapTables(html: string): string {
  if (!html.includes('<table')) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const table of tpl.content.querySelectorAll('table')) {
    const box = document.createElement('div');
    box.className = 'md-table';
    table.replaceWith(box);
    box.append(table);
  }
  return tpl.innerHTML;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => wrapTables(DOMPurify.sanitize(marked.parse(text, { async: false }) as string, MARKDOWN_POLICY)), [text]);
  return <div className={`md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function useRoleLabel(role: string): string {
  return useApp((s) => s.roles.find((r) => r.name === role)?.label ?? humanize(role));
}

export function useRoleLabels(): Record<string, string> {
  const roles = useApp((s) => s.roles);
  return useMemo(() => Object.fromEntries(roles.map((r) => [r.name, r.label])), [roles]);
}

export function humanize(role: string): string {
  if (!role) return '';
  const s = role.replace(/[-_]+/g, ' ');
  return s.length <= 3 ? s.toUpperCase() : s[0]!.toUpperCase() + s.slice(1);
}

/** An agent face with its label from the team definition. */
export function RoleFace({ role, size = 'lg', decorative }: { role: string; size?: FaceSize; decorative?: boolean }) {
  const label = useRoleLabel(role);
  return <Face role={role} label={label} size={size} decorative={decorative} />;
}

export function RoleFaces({ roles, size = 'xs' }: { roles: string[]; size?: FaceSize }) {
  const labels = useRoleLabels();
  return <FaceStack roles={roles} labels={labels} size={size} />;
}

export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, active]);
  return now;
}

/** "45s", "3m", "1h 20m": durations in running text. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Compact age for list meta, as in the designs: "40s", "6m", "1h", "12 Nov". */
export function age(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "35m ago", "just now". */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 86400) return `${age(ts, now)} ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function Elapsed({ since }: { since: number }) {
  const now = useNow();
  return <span className="numeric">{duration(now - since)}</span>;
}

export function oneLine(s: string, max = 140): string {
  const t = s
    .replace(/[*_`]+/g, '')
    .replace(/[#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function engineName(engine: string): string {
  return engine === 'codex' ? 'Codex' : engine === 'grok' ? 'Grok' : engine === 'antigravity' ? 'Antigravity' : 'Claude Code';
}

/** "$0.42", "$12", "<$0.01". */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(usd >= 10 ? 0 : 2)}`;
}

/** "950", "12k", "1.2M". */
export function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Short spend label: the API-price cost when an engine reported one, else the
 * token count. Empty when nothing was used yet.
 */
export function usageLabel(u: Usage | null | undefined): string {
  if (!u) return '';
  if (u.costUsd !== null) return u.unpricedTokens ? `${money(u.costUsd)} + ${tokenCount(u.unpricedTokens)} tok` : money(u.costUsd);
  const total = u.inputTokens + u.outputTokens;
  return total ? `${tokenCount(total)} tok` : '';
}

/** Tooltip for a spend label. */
export function usageTitle(u: Usage | null | undefined): string {
  if (!u) return '';
  const lines = [];
  if (u.costUsd !== null) lines.push(`${money(u.costUsd)} at API prices, as the engines report it`);
  if (u.costUsd !== null && u.unpricedTokens) lines.push(`Plus ${tokenCount(u.unpricedTokens)} tokens from engines that report no price (Codex)`);
  lines.push(`${tokenCount(u.inputTokens)} tokens in, ${tokenCount(u.outputTokens)} out`);
  lines.push('Runs on your subscriptions, so this is what it would cost per token, not what is billed.');
  return lines.join('\n');
}

const PERSON_COLORS = ['#3b6cf6', '#e0538f', '#16a37f', '#d97706', '#8b5cf6', '#0e9fb8', '#dc4c3f', '#5b7c99'];

/** A colleague on the team server: a round face with their initial, coloured by email. */
export function PersonFace({ email, size = 16, title }: { email: string; size?: number; title?: string }) {
  const name = useApp((s) => personName(email, s.people));
  // FNV-1a: spreads similar emails over the colours.
  let h = 2166136261;
  for (const c of email) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return (
    <span
      className="person-face"
      role="img"
      aria-label={name}
      title={title ?? name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55), background: PERSON_COLORS[h % PERSON_COLORS.length] }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** A colleague's name, from the people the conductor knows. */
export function usePersonName(email: string | null | undefined): string {
  return useApp((s) => (email ? personName(email, s.people) : ''));
}

/** Mine / All, for Threads and the Inbox. Only on a team server (someone is signed in). */
export function ScopeToggle({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  const me = useApp((s) => s.me);
  const scope = useApp((s) => s.scope);
  if (!me) return null;
  const option = (value: Scope, label: string) => (
    <button type="button" role="radio" aria-checked={scope === value} className="scope-toggle__option" onClick={() => setScope(value)}>
      {label}
    </button>
  );
  return (
    <span className={`scope-toggle scope-toggle--${tone}`} role="radiogroup" aria-label="Whose threads">
      {option('mine', 'Mine')}
      {option('all', 'All')}
    </span>
  );
}

/** "@Juliette" in a message, marked, for colleagues the conductor knows. */
export function markMentions(text: string, names: string[]): string {
  if (!names.length || !text.includes('@')) return text;
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text.replace(new RegExp(`(^|[^\\w@])@(${alt})(?![\\w])`, 'gi'), '$1<mark>@$2</mark>');
}
