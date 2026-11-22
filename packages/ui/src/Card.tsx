import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** "outline": 1px border (subagent card). "elevated": the approval card. "subtle": lighter divider border. */
  variant?: 'outline' | 'elevated' | 'subtle';
  padded?: boolean;
}

export function Card({ variant = 'outline', padded, className, ...rest }: CardProps) {
  return <div className={cx('cr-card', variant !== 'outline' && `cr-card--${variant}`, padded && 'cr-card--padded', className)} {...rest} />;
}

export function CardHeader({ children }: { children: ReactNode }) {
  return <div className="cr-card__header">{children}</div>;
}

export interface CardRowProps extends HTMLAttributes<HTMLDivElement> {
  spacious?: boolean;
}

export function CardRow({ spacious, className, ...rest }: CardRowProps) {
  return <div className={cx('cr-card__row', spacious && 'cr-card__row--spacious', className)} {...rest} />;
}

/** A whole row that is one button (e.g. a list of people working). */
export function CardRowButton({ spacious, className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { spacious?: boolean }) {
  return (
    <button
      type={type}
      className={cx('cr-card__row', 'cr-card__row--interactive', spacious && 'cr-card__row--spacious', className)}
      {...rest}
    />
  );
}

/** Extra content under a row, indented past the row's face. */
export function CardDetails({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <div className="cr-card__details" id={id}>
      {children}
    </div>
  );
}

export function CardFooter({ children }: { children: ReactNode }) {
  return <div className="cr-card__footer">{children}</div>;
}
