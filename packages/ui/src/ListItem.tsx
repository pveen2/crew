import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';
import { Dot } from './Badge';
import { Icon, type IconName } from './Icon';

export interface ListItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  title: ReactNode;
  /** Top-right: time, spinner + elapsed. */
  meta?: ReactNode;
  /** Second line. */
  subtitle?: ReactNode;
  /** Bottom-right: faces. */
  trailing?: ReactNode;
  unread?: boolean;
  selected?: boolean;
  surface?: 'light' | 'dark';
  tooltip?: string;
}

/** Two-line row used in the sidebar thread list (dark) and the Inbox list (light). */
export function ListItem({ title, meta, subtitle, trailing, unread, selected, surface = 'light', tooltip, className, type = 'button', ...rest }: ListItemProps) {
  return (
    <button
      type={type}
      aria-current={selected ? 'true' : undefined}
      title={tooltip}
      className={cx('cr-list-item', surface === 'dark' && 'cr-list-item--dark', unread && 'cr-list-item--unread', className)}
      {...rest}
    >
      <span className="cr-list-item__line">
        <span className="cr-list-item__title">{title}</span>
        {unread ? <Dot tone={surface === 'dark' ? 'unreadOnDark' : 'unread'} label="Unread" /> : null}
        {meta !== undefined ? <span className="cr-list-item__meta">{meta}</span> : null}
      </span>
      {subtitle !== undefined || trailing ? (
        <span className="cr-list-item__line cr-list-item__line--sub">
          <span className="cr-list-item__subtitle">{subtitle}</span>
          {trailing}
        </span>
      ) : null}
    </button>
  );
}

export interface NavItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  count?: number;
  /** Red dot on the icon: something new. */
  dot?: boolean;
  shortcut?: string;
  selected?: boolean;
  variant?: 'default' | 'raised' | 'quiet';
  /** Replaces the count, e.g. a status. */
  suffix?: ReactNode;
}

/** Sidebar navigation row (dark surface). */
export function NavItem({ icon, label, count, dot, shortcut, selected, variant = 'default', suffix, className, type = 'button', ...rest }: NavItemProps) {
  return (
    <button
      type={type}
      aria-current={selected ? 'page' : undefined}
      className={cx('cr-nav-item', variant !== 'default' && `cr-nav-item--${variant}`, className)}
      {...rest}
    >
      <span className="cr-nav-item__icon">
        <Icon name={icon} />
        {dot ? <Dot tone="notification" /> : null}
      </span>
      <span className="cr-nav-item__label">{label}</span>
      {suffix}
      {count ? (
        <span className="cr-nav-item__count" aria-label={`${count} open`}>
          {count}
        </span>
      ) : null}
      {shortcut ? <kbd className="cr-nav-item__shortcut">{shortcut}</kbd> : null}
    </button>
  );
}
