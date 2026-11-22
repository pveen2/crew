import type { CSSProperties, ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';
import { background, radius, space, type Background, type Radius, type Space } from './tokens';

type Common = Omit<HTMLAttributes<HTMLElement>, 'style'> & {
  as?: ElementType;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

export interface BoxProps extends Common {
  padding?: Space;
  paddingInline?: Space;
  paddingBlock?: Space;
  paddingBlockStart?: Space;
  paddingBlockEnd?: Space;
  background?: Background;
  borderRadius?: Radius;
  /** Draw the 1px border used by cards ("base") or dividers ("subtle"). */
  border?: 'base' | 'subtle';
  grow?: boolean;
}

/** A div with token-only padding, background, radius and border. */
export function Box({
  as: As = 'div',
  padding,
  paddingInline,
  paddingBlock,
  paddingBlockStart,
  paddingBlockEnd,
  background: bg,
  borderRadius,
  border,
  grow,
  className,
  style,
  ...rest
}: BoxProps) {
  const s: CSSProperties = {
    padding: space(padding),
    paddingInline: space(paddingInline),
    paddingBlock: space(paddingBlock),
    paddingBlockStart: space(paddingBlockStart),
    paddingBlockEnd: space(paddingBlockEnd),
    background: background(bg),
    borderRadius: radius(borderRadius),
    boxShadow: border === 'base' ? 'var(--cr-shadow-border)' : border === 'subtle' ? 'var(--cr-shadow-border-subtle)' : undefined,
    flex: grow ? '1 1 auto' : undefined,
    ...style,
  };
  return <As className={cx('cr-box', className)} style={s} {...rest} />;
}

type Align = 'start' | 'center' | 'end' | 'space-between' | 'stretch' | 'baseline';
const flexAlign = (a: Align | undefined) =>
  a === undefined ? undefined : a === 'start' ? 'flex-start' : a === 'end' ? 'flex-end' : a;

export interface StackProps extends Common {
  gap?: Space;
  /** Main-axis alignment. */
  align?: Align;
  /** Cross-axis alignment. */
  blockAlign?: Align;
  inlineAlign?: Align;
  wrap?: boolean;
  grow?: boolean;
  padding?: Space;
  paddingInline?: Space;
  paddingBlock?: Space;
}

function stackStyle(p: StackProps, cross: Align | undefined): CSSProperties {
  return {
    gap: space(p.gap),
    justifyContent: flexAlign(p.align),
    alignItems: flexAlign(cross),
    flex: p.grow ? '1 1 auto' : undefined,
    padding: space(p.padding),
    paddingInline: space(p.paddingInline),
    paddingBlock: space(p.paddingBlock),
    ...p.style,
  };
}

/** Vertical stack. */
export function BlockStack(props: StackProps) {
  const { as: As = 'div', gap, align, blockAlign, inlineAlign, wrap, grow, padding, paddingInline, paddingBlock, className, style, ...rest } = props;
  return (
    <As
      className={cx('cr-stack cr-stack--block', wrap && 'cr-stack--wrap', className)}
      style={stackStyle({ gap, align, grow, padding, paddingInline, paddingBlock, style }, inlineAlign)}
      {...rest}
    />
  );
}

/** Horizontal stack. */
export function InlineStack(props: StackProps) {
  const { as: As = 'div', gap, align, blockAlign = 'center', inlineAlign, wrap, grow, padding, paddingInline, paddingBlock, className, style, ...rest } = props;
  return (
    <As
      className={cx('cr-stack cr-stack--inline', wrap && 'cr-stack--wrap', className)}
      style={stackStyle({ gap, align, grow, padding, paddingInline, paddingBlock, style }, blockAlign)}
      {...rest}
    />
  );
}

/** Pushes siblings apart in a stack. */
export function Spacer() {
  return <span className="cr-spacer" aria-hidden />;
}
