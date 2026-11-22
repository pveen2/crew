import { useId, useState, type ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export function Banner({ tone = 'caution', icon, children }: { tone?: 'caution' | 'critical' | 'info'; icon?: IconName; children: ReactNode }) {
  return (
    <div className={cx('cr-banner', tone !== 'caution' && `cr-banner--${tone}`)} role={tone === 'info' ? 'status' : 'alert'}>
      {icon ? <Icon name={icon} size={14} /> : null}
      <span>{children}</span>
    </div>
  );
}

/** "Worked 6s ›": a quiet trigger that reveals details. */
export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="cr-disclosure">
      <button type="button" className="cr-disclosure__trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {summary}
        <span className="cr-disclosure__chevron">
          <Icon name="chevronRight" size={12} />
        </span>
      </button>
      {open ? (
        <div className="cr-disclosure__content" id={id}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
