import { useState, type ReactNode } from 'react';
import { cx } from './cx';

// "Little faces", bold colour (v5 option B): a coloured disc with white eyes.
// One colour (token --cr-face-<key>) and one eye shape per role.

type Eyes = 'pills' | 'dots' | 'dashes' | 'slants' | 'mixed' | 'arcs';

const FACES: Record<string, { key: string; eyes: Eyes }> = {
  gm: { key: 'gm', eyes: 'pills' },
  'store-manager': { key: 'store-manager', eyes: 'dots' },
  'creative-strategist': { key: 'creative-strategist', eyes: 'dashes' },
  'paid-media': { key: 'paid-media', eyes: 'slants' },
  'paid-media-manager': { key: 'paid-media', eyes: 'slants' },
  'data-analyst': { key: 'data-analyst', eyes: 'mixed' },
  seo: { key: 'seo', eyes: 'dots' },
  'seo-geo': { key: 'seo', eyes: 'dots' },
  'customer-care': { key: 'customer-care', eyes: 'arcs' },
};

const EYES: Record<Eyes, ReactNode> = {
  pills: (
    <>
      <rect x="11" y="12" width="3" height="7" rx="1.5" />
      <rect x="18" y="12" width="3" height="7" rx="1.5" />
    </>
  ),
  dots: (
    <>
      <circle cx="12" cy="15" r="2" />
      <circle cx="20" cy="15" r="2" />
    </>
  ),
  dashes: (
    <>
      <rect x="10" y="14" width="5" height="2.6" rx="1.3" />
      <rect x="17" y="14" width="5" height="2.6" rx="1.3" />
    </>
  ),
  slants: (
    <>
      <rect x="11" y="11" width="3" height="8" rx="1.5" transform="rotate(-12 12.5 15)" />
      <rect x="18" y="11" width="3" height="8" rx="1.5" transform="rotate(12 19.5 15)" />
    </>
  ),
  mixed: (
    <>
      <circle cx="12" cy="15" r="2.6" />
      <rect x="17.5" y="13.7" width="5" height="2.6" rx="1.3" />
    </>
  ),
  arcs: (
    <>
      <path d="M9.5 16a2.5 2.5 0 0 1 5 0" fill="none" strokeWidth="2.2" />
      <path d="M17.5 16a2.5 2.5 0 0 1 5 0" fill="none" strokeWidth="2.2" />
    </>
  ),
};

export type FaceSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
// Mirrors --cr-size-face-* (SVG width/height need numbers).
const PX: Record<FaceSize, number> = { xs: 18, sm: 20, md: 24, lg: 26, xl: 32, '2xl': 36 };

export interface FaceProps {
  /** Role name, e.g. "gm", "store-manager". Unknown roles get the neutral face. */
  role: string;
  /** Accessible name, usually the role label. */
  label?: string;
  size?: FaceSize;
  /** Hide from assistive tech when the name is already next to it. */
  decorative?: boolean;
}

export function Face({ role, label, size = 'lg', decorative }: FaceProps) {
  const f = FACES[role] ?? { key: 'neutral', eyes: 'dots' as Eyes };
  const px = PX[size];
  const name = label ?? role;
  // Hover shows the agent's name right away. Fixed position, so a scrolling list or the sidebar cannot clip it.
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      className={cx('cr-face', `cr-face--${f.key}`)}
      onMouseEnter={
        decorative
          ? undefined
          : (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setTip({ x: r.left + r.width / 2, y: r.bottom });
            }
      }
      onMouseLeave={decorative ? undefined : () => setTip(null)}
    >
      {tip ? (
        <span className="cr-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {name}
        </span>
      ) : null}
      <svg
        width={px}
        height={px}
        viewBox="0 0 32 32"
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : name}
        aria-hidden={decorative ? true : undefined}
      >
        <circle className="cr-face__disc" cx="16" cy="16" r="15" />
        <g className="cr-face__eyes">{EYES[f.eyes]}</g>
      </svg>
    </span>
  );
}

/** Overlapping faces with a ring in the parent's background colour (--cr-face-ring). */
export function FaceStack({
  roles,
  labels,
  size = 'xs',
  max = 4,
}: {
  roles: string[];
  labels?: Record<string, string>;
  size?: FaceSize;
  max?: number;
}) {
  if (!roles.length) return null;
  return (
    <span className={cx('cr-face-stack', (size !== 'xs' && size !== 'sm') && 'cr-face-stack--loose')}>
      {roles.slice(0, max).map((r) => (
        <Face key={r} role={r} label={labels?.[r]} size={size} />
      ))}
    </span>
  );
}
