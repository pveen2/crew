import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ClipboardEvent, type InputHTMLAttributes, type ReactNode } from 'react';
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
}

function fitHeight(el: HTMLTextAreaElement, maxHeight: number) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
}

/** The message box: an auto-growing textarea with slots, as in "Reply, or @ an agent". */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { label, value, onChange, onSubmit, placeholder, disabled, autoFocus, leading, trailing, size = 'default', maxHeight = 220, enterSends = true, onPaste },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current!, []);
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
      onChange={(e) => onChange(e.target.value)}
      onPaste={onPaste}
      enterKeyHint={enterSends ? 'send' : 'enter'}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
        if ((enterSends && !e.shiftKey) || e.metaKey) {
          e.preventDefault();
          onSubmit();
        }
      }}
    />
  );

  if (size === 'tall') {
    return (
      <div className="cr-composer cr-composer--tall">
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
