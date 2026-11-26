import { memo, useEffect, useMemo, useRef, useState } from 'react';
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

function markdownHtml(text: string): string {
  return wrapTables(DOMPurify.sanitize(marked.parse(text, { async: false }) as string, MARKDOWN_POLICY));
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  return <div className={`md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------------------------------------------------------------------------
// Streaming: an agent message shows while it is being written, at an even pace.

/**
 * How far each session's streamed message is shown, so the finished message
 * goes on from there instead of jumping to its full text.
 */
const revealed = new Map<string, { text: string; shown: number; at: number }>();
/** A hand-off older than this is not used: that message finished long ago, or was stopped. */
const HANDOFF_MS = 15_000;

/** Where a message with this text may start showing: from a fresh, matching hand-off, or null. */
function handoff(sessionId: string, text: string): number | null {
  const r = revealed.get(sessionId);
  if (!r || Date.now() - r.at > HANDOFF_MS || !text.startsWith(r.text.slice(0, r.shown))) return null;
  return r.shown;
}

/** Characters a second at the least; a backlog is shown within about this many ms. */
const MIN_RATE = 90;
const CATCH_UP_MS = 300;
/** Re-render at most this often while revealing (Markdown is parsed on each one). */
const FRAME_MS = 32;

/**
 * The part of `target` to show now. Text comes in bursts; this lets it out at a
 * steady pace that speeds up when there is more waiting, so it never lags far behind.
 */
function useReveal(target: string, start: number, onProgress?: (shown: number) => void): number {
  const pos = useRef(Math.min(start, target.length));
  const [shown, setShown] = useState(pos.current);
  const targetRef = useRef(target);
  // What was being shown: when the text no longer starts with it (a retried message), start over.
  const prevRef = useRef(target);
  targetRef.current = target;
  const progress = useRef(onProgress);
  progress.current = onProgress;
  const raf = useRef(0);

  useEffect(() => {
    if (!target.startsWith(prevRef.current.slice(0, pos.current))) pos.current = 0;
    prevRef.current = target;
    if (pos.current > target.length) pos.current = target.length;
    if (pos.current !== shown) setShown(pos.current);
    if (raf.current || pos.current >= target.length) return;
    let last = performance.now();
    let painted = 0;
    let exact = pos.current;
    const tick = (now: number) => {
      const t = targetRef.current;
      const dt = Math.min(now - last, 100);
      last = now;
      if (pos.current < Math.floor(exact)) exact = pos.current; // started over
      const backlog = t.length - exact;
      exact = Math.min(t.length, exact + Math.max((backlog * dt) / CATCH_UP_MS, (MIN_RATE * dt) / 1000));
      pos.current = Math.floor(exact);
      const done = pos.current >= t.length;
      if (done || now - painted >= FRAME_MS) {
        painted = now;
        setShown(pos.current);
        progress.current?.(pos.current);
      }
      raf.current = done ? 0 : requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on new text only
  }, [target]);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      // Strict Mode mounts twice: the next mount must be able to start the loop again.
      raf.current = 0;
    },
    [],
  );
  return shown;
}

/**
 * Markdown cut off mid-way, made to render as it will once finished: an open
 * code fence, bold, or inline code is closed for now, and a lone marker at the
 * very end is left out, so the formatting does not flicker as the text grows.
 */
export function closeOpenMarkdown(text: string): string {
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const f = FENCE.exec(line);
    if (!f) continue;
    if (!fence) fence = f[1]!;
    else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
  }
  if (fence) return text + (text.endsWith('\n') ? '' : '\n') + fence;
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  // A rule (*** or ___) is finished as it is.
  if (/^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/.test(lastLine)) return text;
  let t = text.replace(/[*_`~]+$/, '');
  const line = t.slice(t.lastIndexOf('\n') + 1);
  // Inline code: an open run of backticks is closed with a run as long.
  const runs = line.match(/`+/g) ?? [];
  const open: string[] = [];
  for (const r of runs) {
    if (open.length && open[0] === r) open.pop();
    else if (!open.length) open.push(r);
  }
  if (open.length) return t + open[0];
  if ((line.match(/\*\*/g)?.length ?? 0) % 2 === 1) t += '**';
  if ((line.match(/~~/g)?.length ?? 0) % 2 === 1) t += '~~';
  return t;
}

/** The message being written right now: shown at an even pace, with a caret at its end. Key it by session. */
export function StreamingMarkdown({ sessionId, text }: { sessionId: string; text: string }) {
  // Shown again (another thread and back): go on from where it was.
  const [start] = useState(() => handoff(sessionId, text) ?? 0);
  const shown = useReveal(text, start, (n) => revealed.set(sessionId, { text, shown: n, at: Date.now() }));
  // Remember the latest text too, even before it is shown.
  revealed.set(sessionId, { text, shown, at: Date.now() });
  return <BlockMarkdown text={closeOpenMarkdown(text.slice(0, shown))} seen={start} writing />;
}

/**
 * A finished agent message. Just after it was streamed, it goes on from where
 * the stream had got to; otherwise it shows at once.
 */
export function AgentMarkdown({ sessionId, text, ts }: { sessionId: string; text: string; ts: number }) {
  const [start] = useState(() => {
    // Only the message the draft became: just written, and starting with what was shown.
    const from = Date.now() - ts <= HANDOFF_MS ? handoff(sessionId, text) : null;
    if (from === null) return text.length;
    revealed.delete(sessionId);
    return from;
  });
  const shown = useReveal(text, start);
  // Not streamed: plain. Streamed: kept as blocks, so its DOM (and any sideways scroll) stays.
  if (start >= text.length) return <Markdown text={text} />;
  const writing = shown < text.length;
  return <BlockMarkdown text={writing ? closeOpenMarkdown(text.slice(0, shown)) : text} seen={start} writing={writing} />;
}

// Lines that tie blocks together across blank lines (link definitions, footnotes, raw HTML).
const DOCUMENT_WIDE = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/])|\[\^/m;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * Cuts Markdown at blank lines that end a block, so each piece renders as it
 * would inside the whole text. Whole when the text uses syntax that spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (DOCUMENT_WIDE.test(text)) return [text];
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let afterBlank = false;
  let inList = false;
  for (const line of text.split('\n')) {
    const f = FENCE.exec(line);
    if (fence) {
      current.push(line);
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    // After a blank line, indented content and the next item of a list still belong to the block before.
    const continues = /^[ \t]/.test(line) || (inList && LIST_ITEM.test(line));
    if (afterBlank && line.trim() && !continues && current.some((l) => l.trim())) {
      blocks.push(current.join('\n'));
      current = [];
      inList = false;
    }
    if (f) fence = f[1]!;
    if (LIST_ITEM.test(line)) inList = true;
    afterBlank = !line.trim();
    current.push(line);
  }
  blocks.push(current.join('\n'));
  return blocks;
}

/** One block of a message being written. Unchanged blocks are not parsed again. */
const MarkdownBlock = memo(function MarkdownBlock({ text, fresh }: { text: string; fresh: boolean }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  return <div className={fresh ? 'md-block md-block--new' : 'md-block'} dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * A message being written, block by block: only the last block is parsed again
 * as it grows, and each new block fades in once (as in T3 Code). Blocks already
 * on screen before this mounted (`seen` characters) do not fade again.
 */
function BlockMarkdown({ text, seen, writing }: { text: string; seen: number; writing: boolean }) {
  const blocks = splitMarkdownBlocks(text);
  const [seenBlocks] = useState(() => (seen > 0 ? splitMarkdownBlocks(text.slice(0, seen)).length : 0));
  return (
    <div className={writing ? 'md md--streaming' : 'md'}>
      {blocks.map((block, i) => (
        // Blocks only change at the end.
        <MarkdownBlock key={i} text={block} fresh={i >= seenBlocks} />
      ))}
    </div>
  );
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

/** A colleague's face with a green dot while they have Crew open. */
export function OnlineFace({ email, size = 16 }: { email: string; size?: number }) {
  const on = useApp((s) => s.online.includes(email));
  const name = useApp((s) => personName(email, s.people));
  return (
    <span className={`live-face${on ? ' live-face--on' : ''}`}>
      <PersonFace email={email} size={size} title={on ? `${name} · online` : `${name} · offline`} />
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
  // Longest first: "@Paul Veen" is marked whole, not as "@Paul".
  const alt = [...names]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return text.replace(new RegExp(`(^|[^\\w@])@(${alt})(?![\\w])`, 'gi'), '$1<mark>@$2</mark>');
}
