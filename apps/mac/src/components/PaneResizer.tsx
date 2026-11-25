import type { PointerEvent } from 'react';

/**
 * A drag handle between two panes, like T3 Code's (col-resize cursor, a 1px
 * line on hover). It sizes the pane before it (`target="before"`, e.g. the
 * Inbox list) or after it (`target="after"`, e.g. the preview).
 * Double-click resets to the default split.
 */
export function PaneResizer({
  target,
  label,
  min,
  minOther,
  onResize,
  onReset,
}: {
  target: 'before' | 'after';
  label: string;
  /** Smallest width of the sized pane. */
  min: number;
  /** Smallest width left for the other pane. */
  minOther: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const pane = (target === 'after' ? handle.nextElementSibling : handle.previousElementSibling) as HTMLElement | null;
    const panes = handle.parentElement;
    if (!pane || !panes) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = pane.getBoundingClientRect().width;
    // The gap between the panes is not the other pane's, so it comes off too.
    const gap = parseFloat(getComputedStyle(panes).columnGap) || 0;
    const max = Math.max(min, panes.getBoundingClientRect().width - minOther - gap);
    const sign = target === 'after' ? -1 : 1;
    document.body.classList.add('is-resizing');
    handle.classList.add('is-active');

    const move = (ev: globalThis.PointerEvent) => {
      onResize(Math.max(min, Math.min(max, startWidth + sign * (ev.clientX - startX))));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-resizing');
      handle.classList.remove('is-active');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  return (
    <div
      className="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  );
}
