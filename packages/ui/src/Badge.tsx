import type { ReactNode } from 'react';
import { cx } from './cx';

export type BadgeTone = 'neutral' | 'subtle' | 'info' | 'success' | 'caution' | 'critical';

/** Status chip, e.g. "Working · 3m", "Queued". */
export function Badge({ tone = 'neutral', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={cx('cr-badge', tone !== 'neutral' && `cr-badge--${tone}`)} title={title}>
      {children}
    </span>
  );
}

/**
 * Small round indicator. "unread" for list items on white, "unreadOnDark" in the
 * sidebar, "notification" is the red dot pinned to an icon's corner.
 */
export function Dot({ tone = 'unread', label }: { tone?: 'unread' | 'unreadOnDark' | 'notification'; label?: string }) {
  return (
    <span
      className={cx('cr-dot', tone !== 'unread' && `cr-dot--${tone}`)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function Spinner({ size = 11, tone = 'neutral', label = 'Working' }: { size?: 11 | 12 | 14; tone?: 'neutral' | 'info'; label?: string }) {
  return (
    <svg
      className={cx('cr-spinner', tone === 'info' && 'cr-spinner--info')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      role="img"
      aria-label={label}
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}

/** Status text with a light sweeping left to right, e.g. "Thinking". */
export function Shimmer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('cr-shimmer', className)} role="status">
      {children}
    </span>
  );
}
