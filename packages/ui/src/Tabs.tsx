import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from './Icon';

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** Pill tabs, as in the preview pane header. Arrow keys move between tabs. With `onClose`, a close button shows on hover. */
export function Tabs<V extends string>({
  items,
  value,
  onValueChange,
  onClose,
  label,
}: {
  items: TabItem<V>[];
  value: V | undefined;
  onValueChange: (v: V) => void;
  onClose?: (v: V) => void;
  label: string;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const enabled = items.filter((i) => !i.disabled);
    const idx = enabled.findIndex((i) => i.value === value);
    const next = enabled[(idx + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    if (next) {
      onValueChange(next.value);
      const el = e.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`);
      el?.focus();
    }
  };
  return (
    <div className="cr-tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
      {items.map((i) => {
        const tab = (
          <button
            key={i.value}
            type="button"
            role="tab"
            data-value={i.value}
            className="cr-tab"
            aria-selected={i.value === value}
            tabIndex={i.value === value ? 0 : -1}
            disabled={i.disabled}
            title={i.title}
            onClick={() => onValueChange(i.value)}
          >
            <span>{i.label}</span>
          </button>
        );
        if (!onClose) return tab;
        return (
          <span key={i.value} className="cr-tab-item">
            {tab}
            <button
              type="button"
              className="cr-tab__close"
              aria-label={`Close ${i.title ?? 'tab'}`}
              title="Close"
              onClick={() => onClose(i.value)}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Two or three mutually exclusive options (All / Unread, Desktop / Phone). */
export function SegmentedControl<V extends string>({
  items,
  value,
  onValueChange,
  label,
}: {
  items: Array<{ value: V; label: ReactNode }>;
  value: V;
  onValueChange: (v: V) => void;
  label: string;
}) {
  return (
    <div className="cr-segmented" role="group" aria-label={label}>
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          className="cr-segmented__item"
          aria-pressed={i.value === value}
          onClick={() => onValueChange(i.value)}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}
