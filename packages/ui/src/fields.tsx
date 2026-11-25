import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size'> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  icon?: IconName;
  /** Show the label visually (otherwise it is only for screen readers). */
  showLabel?: boolean;
  /** "message": for writing a message, at the size of message text (like the composer). */
  variant?: 'default' | 'message';
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, value, onChange, icon, showLabel, variant = 'default', className, disabled, ...rest },
  ref,
) {
  return (
    <label className={cx('cr-text-field', variant === 'message' && 'cr-text-field--message', disabled && 'cr-text-field--disabled', className)}>
      <span className={showLabel ? undefined : 'cr-visually-hidden'}>{label}</span>
      {icon ? <Icon name={icon} size={14} /> : null}
      <input ref={ref} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...rest} />
    </label>
  );
});

export interface ComposerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Slot before the text (attach). */
  leading?: ReactNode;
  /** Slot after the text (agent chip, send). */
  trailing?: ReactNode;
  /** "tall": the bigger box on the New thread screen, with the trailing slot in a bar below. */
  size?: 'default' | 'tall';
  maxHeight?: number;
  /** Enter sends (default). With false, Cmd+Enter sends. */
  enterSends?: boolean;
  /** Paste handler on the text area, e.g. to take pasted images. */
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Typing "@" opens a menu of these; picking one writes "@<value> ". */
  mentions?: MentionOption[];
}

export interface MentionOption {
  /** Written after the "@", e.g. "developer". */
  value: string;
  label: string;
  /** A second line, e.g. what the agent does. */
  description?: string;
  /** Shown before the label, e.g. a Face. */
  prefix?: ReactNode;
}

/** The "@word" the caret is in, if any: "@" at the start or after a space. */
function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@([\w-]*)$/.exec(value.slice(0, caret));
  return m ? { start: caret - m[1]!.length - 1, query: m[1]!.toLowerCase() } : null;
}

function fitHeight(el: HTMLTextAreaElement, maxHeight: number) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
}

/** The message box: an auto-growing textarea with slots, as in "Reply, or @ an agent". */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { label, value, onChange, onSubmit, placeholder, disabled, autoFocus, leading, trailing, size = 'default', maxHeight = 220, enterSends = true, onPaste, mentions },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current!, []);

  // The @ menu: open while the caret is in an "@word"; Escape hides it until the word changes.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    if (!mention || !mentions?.length) return [];
    const q = mention.query;
    const hit = (o: MentionOption) => [o.value.toLowerCase(), o.label.toLowerCase()];
    const starts = mentions.filter((o) => hit(o).some((k) => k.startsWith(q)));
    const within = mentions.filter((o) => !starts.includes(o) && hit(o).some((k) => k.includes(q)));
    return [...starts, ...within];
  }, [mention, mentions]);
  const menuOpen = matches.length > 0 && mention !== null && dismissed !== mention.start;
  const track = (el: HTMLTextAreaElement) => {
    const next = el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart) : null;
    setMention((prev) => (prev?.start === next?.start && prev?.query === next?.query ? prev : next));
    if (!next) setDismissed(null);
  };
  useEffect(() => setActive(0), [mention?.start, mention?.query]);
  const pick = (o: MentionOption) => {
    const el = inner.current;
    if (!el || !mention) return;
    const caret = el.selectionStart;
    const insert = `@${o.value} `;
    // The rest of the word the caret was in, and one space after it (never a newline).
    const after = value.slice(caret).replace(/^[\w-]* ?/, '');
    onChange(value.slice(0, mention.start) + insert + after);
    setMention(null);
    const at = mention.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  };
  const menuId = useMemo(() => `cr-mentions-${Math.random().toString(36).slice(2, 8)}`, []);
  // Keep the highlighted agent in view, scrolling only the list (never the page around it).
  useEffect(() => {
    const item = menuOpen ? document.getElementById(`${menuId}-${active}`) : null;
    const list = item?.parentElement;
    if (!item || !list) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  }, [menuOpen, active, matches, menuId]);
  // Fit the box to its text: on every change, and whenever its width changes
  // (a pane resized or a preview opened), since narrower means more lines.
  useLayoutEffect(() => {
    const el = inner.current;
    if (el) fitHeight(el, maxHeight);
  }, [value, maxHeight]);
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return; // our own height change, not a new width
      width = el.clientWidth;
      fitHeight(el, maxHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [maxHeight]);

  const textarea = (
    <textarea
      ref={inner}
      rows={1}
      aria-label={label}
      value={value}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => {
        onChange(e.target.value);
        track(e.target);
      }}
      onSelect={(e) => track(e.currentTarget)}
      onBlur={() => setMention(null)}
      onPaste={onPaste}
      enterKeyHint={enterSends ? 'send' : 'enter'}
      aria-autocomplete={mentions ? 'list' : undefined}
      aria-controls={menuOpen ? menuId : undefined}
      aria-activedescendant={menuOpen ? `${menuId}-${active}` : undefined}
      onKeyDown={(e) => {
        // keyCode 229: Safari's Return that commits an IME candidate, sent with isComposing false.
        if (menuOpen && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = matches.length;
            setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
            return;
          }
          // Plain Enter or Tab picks; Shift+Enter still adds a line and Shift+Tab moves focus back.
          if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey) {
            e.preventDefault();
            pick(matches[active] ?? matches[0]!);
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setDismissed(mention!.start);
            return;
          }
        }
        if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if ((enterSends && !e.shiftKey) || e.metaKey) {
          e.preventDefault();
          onSubmit();
        }
      }}
    />
  );

  const menu = menuOpen ? (
    <div className={cx('cr-mention-menu', size === 'tall' && 'cr-mention-menu--below')} id={menuId} role="listbox" aria-label="Agents">
      {matches.map((o, i) => (
        <div
          key={o.value}
          id={`${menuId}-${i}`}
          role="option"
          aria-selected={i === active}
          className={cx('cr-mention-menu__item', i === active && 'cr-mention-menu__item--active')}
          // Keep the focus (and the caret) in the text while picking with the mouse.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(o)}
          onMouseEnter={() => setActive(i)}
        >
          {o.prefix}
          <span className="cr-mention-menu__text">
            <span className="cr-mention-menu__label">{o.label}</span>
            {o.description ? <span className="cr-mention-menu__description">{o.description}</span> : null}
          </span>
        </div>
      ))}
    </div>
  ) : null;

  if (size === 'tall') {
    return (
      <div className="cr-composer cr-composer--tall">
        {menu}
        {textarea}
        <div className="cr-composer__bar">
          {leading}
          <span className="cr-spacer" />
          {trailing}
        </div>
      </div>
    );
  }
  return (
    <div className="cr-composer">
      {menu}
      {leading ? <span className="cr-composer__slot">{leading}</span> : null}
      {textarea}
      {trailing ? <span className="cr-composer__slot">{trailing}</span> : null}
    </div>
  );
});

export interface ChipSelectProps<V extends string> {
  label: string;
  value: V;
  options: Array<{ value: V; label: string }>;
  onChange: (v: V) => void;
  disabled?: boolean;
  /** Shown before the selected label, e.g. a Face. */
  prefix?: ReactNode;
  /** A shorter text for the chip than the selected option's label (the menu keeps the full labels). */
  display?: ReactNode;
}

/** A quiet "GM ⌄" chip. A native select sits on top, so keyboard and VoiceOver work as usual. */
export function ChipSelect<V extends string>({ label, value, options, onChange, disabled, prefix, display }: ChipSelectProps<V>) {
  const current = options.find((o) => o.value === value);
  return (
    <span className={cx('cr-chip-select', disabled && 'cr-chip-select--disabled')}>
      {prefix}
      <span aria-hidden>{display ?? current?.label ?? value}</span>
      <Icon name="chevronDown" size={12} />
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as V)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}
