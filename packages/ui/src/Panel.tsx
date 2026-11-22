import type { HTMLAttributes } from 'react';
import { cx } from './cx';

/** The white rounded panes that sit on the dark app background. */
export function Panel({ className, as: As = 'section', ...rest }: HTMLAttributes<HTMLElement> & { as?: 'section' | 'main' | 'aside' }) {
  return <As className={cx('cr-panel', className)} {...rest} />;
}

export interface PanelHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** "lg" is the 56px thread header with a title and subtitle. */
  size?: 'md' | 'lg';
  /** Drag the window from this header (Electron, hidden title bar). */
  draggable?: boolean;
}

export function PanelHeader({ size = 'md', draggable = true, className, ...rest }: PanelHeaderProps) {
  return <div className={cx('cr-panel__header', size === 'lg' && 'cr-panel__header--lg', draggable && 'cr-drag', className)} {...rest} />;
}

export function PanelBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('cr-panel__body', className)} {...rest} />;
}
