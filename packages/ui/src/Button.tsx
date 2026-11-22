import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'tertiary' | 'plain';
  size?: 'slim' | 'medium' | 'large';
  icon?: IconName;
  fullWidth?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'medium', icon, fullWidth, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('cr-button', `cr-button--${variant}`, `cr-button--${size}`, fullWidth && 'cr-button--full', className)}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'slim' ? 13 : 14} /> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Required: icon-only buttons need an accessible name. */
  label: string;
  icon: IconName;
  size?: 'sm' | 'md';
  /** "dark" for the sidebar, "primary" for the round send button. */
  tone?: 'light' | 'dark' | 'primary';
  pressed?: boolean;
  iconSize?: 12 | 13 | 14 | 15;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'sm', tone = 'light', pressed, iconSize, className, type = 'button', title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      className={cx(
        'cr-icon-button',
        size === 'md' && 'cr-icon-button--md',
        tone !== 'light' && `cr-icon-button--${tone}`,
        pressed && 'cr-icon-button--pressed',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={iconSize ?? (tone === 'primary' ? 15 : 15)} strokeWidth={tone === 'primary' ? 2 : undefined} />
    </button>
  );
});
