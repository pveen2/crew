import type { CSSProperties, ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type TextVariant = 'headingLg' | 'headingMd' | 'headingSm' | 'bodyLg' | 'bodyMd' | 'bodySm' | 'caption' | 'micro' | 'label';
export type TextTone =
  | 'base'
  | 'secondary'
  | 'tertiary'
  | 'emphasis'
  | 'info'
  | 'success'
  | 'caution'
  | 'critical'
  | 'sidebar'
  | 'sidebarStrong'
  | 'sidebarMuted'
  | 'sidebarSecondary'
  | 'inherit';

export interface TextProps extends Omit<HTMLAttributes<HTMLElement>, 'style'> {
  as?: ElementType;
  variant?: TextVariant;
  tone?: TextTone;
  weight?: 'regular' | 'medium' | 'semibold' | 'bold';
  truncate?: boolean;
  leading?: 'tight' | 'snug';
  numeric?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}

const defaultElement: Record<TextVariant, ElementType> = {
  headingLg: 'h1',
  headingMd: 'h2',
  headingSm: 'h3',
  bodyLg: 'p',
  bodyMd: 'p',
  bodySm: 'p',
  caption: 'span',
  micro: 'span',
  label: 'span',
};

export function Text({ as, variant = 'bodyLg', tone, weight, truncate, leading, numeric, className, ...rest }: TextProps) {
  const As = as ?? defaultElement[variant];
  return (
    <As
      className={cx(
        'cr-text',
        `cr-text--${variant}`,
        tone && tone !== 'inherit' && `cr-text--tone-${tone}`,
        weight && `cr-text--${weight}`,
        truncate && 'cr-text--truncate',
        leading && `cr-text--${leading}`,
        numeric && 'cr-text--numeric',
        className,
      )}
      {...rest}
    />
  );
}
