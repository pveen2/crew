import { useEffect } from 'react';
import { getState, isPhone, toggleNav } from './store';

/** How close to the left edge a swipe must start to pull the menu open. */
const EDGE = 28;

/**
 * On a phone the menu follows your finger, as in the ChatGPT and Claude apps:
 * swipe right from the left edge to pull it open, swipe left to push it away.
 */
export function useNavSwipe(): void {
  useEffect(() => {
    if (window.crewHost) return;
    let drag: { x: number; y: number; t: number; open: boolean; dx: number; locked: boolean | null } | null = null;
    const nav = () => document.querySelector<HTMLElement>('.sidebar');
    const backdrop = () => document.querySelector<HTMLElement>('.nav-backdrop');

    const onStart = (e: TouchEvent) => {
      if (!isPhone() || e.touches.length !== 1) return;
      const open = getState().navOpen;
      const { clientX: x, clientY: y } = e.touches[0]!;
      // Closed: only from the edge, so a swipe over a wide table still scrolls it.
      if (!open && x > EDGE) return;
      drag = { x, y, t: Date.now(), open, dx: 0, locked: null };
    };

    const onMove = (e: TouchEvent) => {
      if (!drag) return;
      const { clientX, clientY } = e.touches[0]!;
      const dx = clientX - drag.x;
      const dy = clientY - drag.y;
      // Decide once: a sideways swipe moves the menu, anything else scrolls.
      if (drag.locked === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        drag.locked = Math.abs(dx) > Math.abs(dy);
        if (!drag.locked) {
          drag = null;
          return;
        }
      }
      e.preventDefault();
      const el = nav();
      if (!el) return;
      const width = el.offsetWidth;
      drag.dx = dx;
      // Where the menu's left edge is: -width (closed) up to 0 (open).
      const offset = Math.max(-width, Math.min(0, (drag.open ? 0 : -width) + dx));
      el.style.transition = 'none';
      el.style.transform = `translateX(${offset}px)`;
      const bd = backdrop();
      if (bd) bd.style.opacity = String(1 + offset / width);
    };

    const onEnd = () => {
      if (!drag) return;
      const { dx, t, open, locked } = drag;
      drag = null;
      const el = nav();
      if (el) {
        el.style.transition = '';
        el.style.transform = '';
      }
      const bd = backdrop();
      if (bd) bd.style.opacity = '';
      if (!locked) return;
      const width = el?.offsetWidth ?? 300;
      const fast = Math.abs(dx) / Math.max(1, Date.now() - t) > 0.4;
      if (!open && (dx > width / 3 || (fast && dx > 0))) toggleNav(true);
      else if (open && (dx < -width / 3 || (fast && dx < 0))) toggleNav(false);
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, []);
}
