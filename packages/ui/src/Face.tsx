import { useEffect, useState, type ReactNode } from 'react';
import { cx } from './cx';

// Agent faces (crew-icons): a bold colour disc, a black ring and one mouth line.
// No eyes. The mouth is the agent's identity, and it changes to show state.
// Disc colour comes from the token --cr-face-<key>; ring and mouth use --cr-face-ink.

/** idle = the agent's own mouth; the other states share one mouth across agents. */
export type FaceState = 'idle' | 'working' | 'thinking' | 'needs-you' | 'done';

// Mouth paths in a 100×100 viewBox, from crew-icons/svg/<agent>.svg.
const MOUTHS: Record<string, ReactNode> = {
  gm: <path d="M66 42 A 19 19 0 0 1 43 66" />,
  developer: <path d="M40 58 L 60 58" />,
  'store-manager': <path d="M36 54 Q 50 69 64 54" />,
  'data-analyst': <path d="M36 61 L 44 53 L 52 59 L 64 46" />,
  'paid-media': <circle cx="50" cy="58" r="7" />,
  'creative-strategist': <path d="M36 58 Q 43 51 50 58 T 64 58" />,
  'creative-producer': <path d="M40 60 Q 53 65 63 51" />,
  'brand-reviewer': <path d="M38 58 L 62 55" />,
  'email-and-retention': <path d="M43 56 Q 50 64 57 56" />,
  'customer-care': <path d="M37 50 Q 50 74 63 50" />,
  'social-and-community': <path d="M38 52 L 62 52 Q 62 69 50 69 Q 38 69 38 52 Z" />,
  'finance-and-operations': <path d="M45 58 Q 50 62 55 58" />,
  'seo-and-geo': <path d="M34 42 A 19 19 0 0 0 57 66" />,
  dj: <path d="M37 54 Q 43 65 50 56 Q 57 65 63 54" />,
  copywriter: <path d="M37 58 L 45 58 M 55 58 L 63 58" />,
  designer: <path d="M36 55 L 43 61 L 50 55 L 57 61 L 64 55" />,
  'web-researcher': (
    <>
      <circle cx="39" cy="58" r="1" />
      <circle cx="50" cy="58" r="1" />
      <circle cx="61" cy="58" r="1" />
    </>
  ),
  neutral: <path d="M44 58 L 56 58" />,
};

// Older or alternative role names that map to the same face.
const ALIASES: Record<string, string> = {
  'paid-media-manager': 'paid-media',
  seo: 'seo-and-geo',
  'seo-geo': 'seo-and-geo',
  'email-retention': 'email-and-retention',
  'social-community': 'social-and-community',
  'finance-operations': 'finance-and-operations',
  'finance-ops': 'finance-and-operations',
  'copy-writer': 'copywriter',
  'web-research': 'web-researcher',
  researcher: 'web-researcher',
};

const STATE_MOUTHS: Record<Exclude<FaceState, 'idle'>, ReactNode> = {
  working: (
    <path d="M40 57 Q 50 57 60 57">
      <animate
        attributeName="d"
        values="M40 57 Q 50 57 60 57;M40 57 Q 50 70 60 57;M40 57 Q 50 60 60 57;M40 57 Q 50 68 60 57;M40 57 Q 50 57 60 57"
        dur="1.1s"
        repeatCount="indefinite"
      />
    </path>
  ),
  thinking: (
    <path d="M42 58 L 58 58">
      <animate
        attributeName="d"
        values="M42 58 L 58 58;M38 58 L 54 58;M46 58 L 62 58;M42 58 L 58 58"
        dur="2.4s"
        repeatCount="indefinite"
      />
    </path>
  ),
  'needs-you': <circle cx="50" cy="58" r="7" />,
  done: <path d="M36 52 Q 50 72 64 52" />,
};

export function faceKey(role: string): string {
  const k = ALIASES[role] ?? role;
  return k in MOUTHS ? k : 'neutral';
}

export type FaceSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
// Mirrors --cr-size-face-* (SVG width/height need numbers).
const PX: Record<FaceSize, number> = { xs: 18, sm: 20, md: 24, lg: 26, xl: 32, '2xl': 36 };

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export interface FaceProps {
  /** Role name, e.g. "gm", "store-manager". Unknown roles get the neutral face. */
  role: string;
  /** Accessible name, usually the role label. */
  label?: string;
  size?: FaceSize;
  /** What the agent is doing. Animated states fall back to idle under reduced motion. */
  state?: FaceState;
  /** Hide from assistive tech when the name is already next to it. */
  decorative?: boolean;
}

export function Face({ role, label, size = 'lg', state = 'idle', decorative }: FaceProps) {
  const key = faceKey(role);
  const px = PX[size];
  const name = label ?? role;
  const reduced = useReducedMotion();
  const shown: FaceState = reduced && (state === 'working' || state === 'thinking') ? 'idle' : state;
  // Hover shows the agent's name right away. Fixed position, so a scrolling list or the sidebar cannot clip it.
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      className={cx('cr-face', `cr-face--${key}`)}
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
        viewBox="0 0 100 100"
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : name}
        aria-hidden={decorative ? true : undefined}
      >
        <circle className="cr-face__disc" cx="50" cy="50" r="50" />
        {/* Thicker lines at 32 px and below, as the small icon set does. */}
        <g className="cr-face__ink" strokeWidth={px <= 32 ? 7.5 : 6}>
          <circle cx="50" cy="50" r="33" />
          {shown === 'idle' ? MOUTHS[key] : STATE_MOUTHS[shown]}
        </g>
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
