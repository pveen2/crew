import { useEffect } from 'react';
import { getState, isPhone, toggleNav } from './store';

/** How close to the left edge a swipe must start to pull the menu open. */
const EDGE = 28;

/** A touch screen without hover: a phone or tablet. */
export function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/** A phone: narrow and touch. Return adds a line here, and the send button sends. */
export function isPhoneTouch(): boolean {
  return isPhone() && isTouch();
}

/** Something on top of the page (a dialog, the image viewer) owns the swipe. */
function overlayOpen(): boolean {
  return Boolean(document.querySelector('dialog[open], .image-lightbox, .pane-preview'));
}

/** Text you can select or type in, or something that scrolls sideways, keeps the swipe. */
function ownsSwipe(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (el.closest('.sidebar')) return false; // the menu itself: ours
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) return true;
    if (el.scrollWidth > el.clientWidth + 1) {
      const x = getComputedStyle(el).overflowX;
      if (x === 'auto' || x === 'scroll') return true;
    }
  }
  return false;
}

type Drag = { id: number; x: number; y: number; t: number; open: boolean; dx: number; locked: boolean | null };

/**
 * On a phone the menu follows your finger, as in the ChatGPT and Claude apps:
 * swipe right from the left edge to pull it open, swipe left to push it away.
 */
export function useNavSwipe(): void {
  useEffect(() => {
    if (window.crewHost) return;
    let drag: Drag | null = null;
    const nav = () => document.querySelector<HTMLElement>('.sidebar');
    const backdrop = () => document.querySelector<HTMLElement>('.nav-backdrop');

    /** Put the menu back where the store says it is. */
    const reset = () => {
      for (const el of [nav(), backdrop()]) {
        if (!el) continue;
        el.style.transition = '';
        el.style.transform = '';
        el.style.opacity = '';
      }
    };
    const abort = () => {
      if (drag?.locked) reset();
      drag = null;
    };
    const tracked = (list: TouchList) => (drag ? Array.from(list).find((t) => t.identifier === drag!.id) : undefined);

    const onStart = (e: TouchEvent) => {
      // A second finger: not a swipe any more.
      if (drag) return abort();
      if (!isPhone() || e.touches.length !== 1 || overlayOpen()) return;
      const open = getState().navOpen;
      const t = e.touches[0]!;
      // Closed: only from the edge, so a swipe over a wide table still scrolls it.
      if (!open && (t.clientX > EDGE || ownsSwipe(e.target))) return;
      drag = { id: t.identifier, x: t.clientX, y: t.clientY, t: Date.now(), open, dx: 0, locked: null };
    };

    const onMove = (e: TouchEvent) => {
      const t = tracked(e.touches);
      if (!drag || !t) return;
      const dx = t.clientX - drag.x;
      const dy = t.clientY - drag.y;
      // Decide once: a sideways swipe the menu can follow moves it, anything else scrolls.
      if (drag.locked === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        const towards = drag.open ? dx < 0 : dx > 0;
        if (Math.abs(dx) <= Math.abs(dy) || !towards || !e.cancelable) {
          drag = null;
          return;
        }
        drag.locked = true;
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
      if (bd) {
        bd.style.transition = 'none';
        bd.style.opacity = String(1 + offset / width);
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (!drag || !tracked(e.changedTouches)) return;
      const { dx, t, open, locked } = drag;
      const width = nav()?.offsetWidth ?? 300;
      drag = null;
      if (!locked) return;
      reset();
      const fast = Math.abs(dx) / Math.max(1, Date.now() - t) > 0.4;
      if (!open && (dx > width / 3 || (fast && dx > 0))) toggleNav(true);
      else if (open && (dx < -width / 3 || (fast && dx < 0))) toggleNav(false);
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', abort);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', abort);
    };
  }, []);
}
