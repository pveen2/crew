// Token keys as TypeScript types, so props can only take values from the scale.

export type Space =
  | '0'
  | '025'
  | '050'
  | '075'
  | '100'
  | '150'
  | '175'
  | '200'
  | '225'
  | '250'
  | '300'
  | '350'
  | '400'
  | '450'
  | '500'
  | '600'
  | '700'
  | '800'
  | '1000';

export type Radius = '100' | '150' | '200' | '250' | '300' | '350' | '400' | '500' | '600' | '700' | 'full';

export type Background =
  | 'surface'
  | 'surface-secondary'
  | 'surface-tertiary'
  | 'fill'
  | 'fill-selected'
  | 'skeleton'
  | 'sidebar'
  | 'sidebar-raised'
  | 'caution'
  | 'critical'
  | 'info';

export const space = (s: Space | undefined) => (s === undefined ? undefined : `var(--cr-space-${s})`);
export const radius = (r: Radius | undefined) => (r === undefined ? undefined : `var(--cr-radius-${r})`);
export const background = (b: Background | undefined) => (b === undefined ? undefined : `var(--cr-color-bg-${b})`);
