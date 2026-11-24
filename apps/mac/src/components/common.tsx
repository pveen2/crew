import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Face, FaceStack, type FaceSize } from '@crew/ui';
import type { Usage } from '@crew/protocol';
import { useApp } from '../store';

marked.setOptions({ gfm: true, breaks: false });

/**
 * Agent-written Markdown is untrusted. Allow document formatting only: no inline
 * styles, classes, ids, forms, media or embeds, so an answer cannot restyle or
 * imitate the app's own controls. HTML documents go to the sandboxed preview iframe.
 */
const MARKDOWN_POLICY = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub',
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

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, MARKDOWN_POLICY), [text]);
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
  if (u.costUsd !== null) return money(u.costUsd);
  const total = u.inputTokens + u.outputTokens;
  return total ? `${tokenCount(total)} tok` : '';
}

/** Tooltip for a spend label. */
export function usageTitle(u: Usage | null | undefined): string {
  if (!u) return '';
  const lines = [];
  if (u.costUsd !== null) lines.push(`${money(u.costUsd)} at API prices (as Claude Code reports it)`);
  lines.push(`${tokenCount(u.inputTokens)} tokens in, ${tokenCount(u.outputTokens)} out`);
  lines.push('Runs on your subscriptions, so this is what it would cost per token, not what is billed.');
  return lines.join('\n');
}
