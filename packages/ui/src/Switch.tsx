import { cx } from './cx';

/** An on/off switch. Label it with `label`, or point `labelledBy` at visible text. */
export function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  describedBy,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      className={cx('cr-switch', checked && 'cr-switch--on')}
      onClick={() => onChange(!checked)}
    >
      <span className="cr-switch__thumb" aria-hidden />
    </button>
  );
}
