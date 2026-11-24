# Crew design system (`@crew/ui`)

A small, local design system for the Crew Mac app. The source of truth for the
look is the owner's v5 designs: the "v5 Final (F)" page of the "Crew app: first
mockups" canvas (https://claude.ai/artifact/DxRiyQNEEe4ytvEdu9AyB3). They are not
copied into this repo. This note explains how that look became tokens and
components, and what was borrowed from other systems.

Package: `packages/ui` (`@crew/ui`). Plain React + CSS, no build step: Vite
compiles the TypeScript and CSS straight from `src/`. No UI library underneath.

## What we took, and why

**Shopify Polaris** (structure)
- *Token layers.* Polaris separates primitive values from semantic tokens
  (`--p-color-bg-surface`, `--p-color-text-secondary`, `--p-color-border`).
  Components only use semantic tokens, so a palette change is one file. We do the
  same: `--cr-gray-*`, `--cr-red-*` … are primitives, `--cr-color-*` are semantic,
  and components never touch a primitive.
- *Numeric spacing scale.* Polaris names space by multiples of 4px
  (`space-100` = 4px, `space-200` = 8px, `space-050` = 2px). The v5 designs use
  a lot of off-grid values (3, 7, 9, 10, 14, 18px), so we keep the Polaris naming
  but add the in-between steps the design actually uses (`space-075` = 3px,
  `space-225` = 9px, `space-350` = 14px …) instead of rounding the design away.
- *Layout primitives.* `Box`, `BlockStack` (vertical) and `InlineStack`
  (horizontal) with `gap`/`padding` props that only accept token keys. Screens
  are composed from these instead of one-off CSS.
- *Text with variants* (`headingLg`, `bodyMd`, `bodySm` …) and tones
  (`secondary`, `critical`) instead of free font sizes.
- *Button variants and sizes* (`primary` / `secondary` / `tertiary`,
  `slim` / `medium` / `large`).

**Radix Themes / Radix Colors** (naming and states)
- *Step-based gray scale* where each step has a job (app background, subtle
  background, hover, border, solid, text). Our grays follow the v5 hex values but
  are ordered and named the Radix way, light to dark.
- *Explicit interaction states per component*: hover, active (pressed),
  `focus-visible` and disabled are all defined in CSS, keyed off
  `:focus-visible` (never `:focus`), and disabled uses the native `disabled`
  attribute so it is also not focusable.
- `SegmentedControl` and `Tabs` APIs (`value`, `onValueChange`, items) follow
  Radix naming.

**GitHub Primer** (accessibility)
- *Focus ring as a token* (`--cr-focus-ring`): 2px, offset, high-contrast blue
  that works on both the dark sidebar and the white panels.
- *IconButton requires a label* (`aria-label` is a required prop), as in
  Primer's `IconButton`.
- `Tabs` use `role="tablist"`/`role="tab"`/`aria-selected`; the segmented
  control uses `aria-pressed`; the counter next to Inbox has an accessible label.

**Linear-style apps** (density)
- Dark navigation rail with white "card" panels, 13.5px base text, 28–32px
  controls, borders drawn as 1px box-shadows (no layout shift), and
  `prefers-reduced-motion` respected for spinners.

## Tokens (`src/tokens.css`)

Primitives
- Gray: `--cr-gray-0` #FFFFFF, `25` #FAFAFA, `50` #F7F7F7, `75` #F4F4F4,
  `100` #F2F2F2, `150` #F0F0F0, `175` #EFEFEF, `200` #EDEDED, `250` #E8E8E8,
  `275` #E6E6E6, `300` #E2E2E2, `400` #CFCFCF, `500` #8F8F8F, `600` #6E6E6E,
  `700` #3A3A3A, `800` #2A2A2A, `850` #232323, `875` #1C1C1C, `900` #1F1F1F,
  `950` #111111
- Accents: `--cr-red-500` #E5484D, `--cr-blue-600` #005BD3, `--cr-green-600`
  #29845A, `--cr-amber-*`, `--cr-red-50/700` (state colours for interrupted and
  failed, not in v5 but needed by real data)
- Agent faces (sizes `--cr-size-face-xs` 18 … `-2xl` 36): one disc colour per agent,
  `--cr-face-gm` #F0531F, `--cr-face-developer` #2F5BEA, `--cr-face-store-manager` #1FAE5B, `--cr-face-data-analyst` #F7C31C, `--cr-face-paid-media` #23A8F0, `--cr-face-creative-strategist` #F2408C, `--cr-face-creative-producer` #9ACD2A, `--cr-face-brand-reviewer` #E0262E, `--cr-face-email-and-retention` #FF85B3, `--cr-face-customer-care` #10B0A3, `--cr-face-social-and-community` #D94FD3, `--cr-face-finance-and-operations` #C07F2C, `--cr-face-seo-and-geo` #138A4E, `--cr-face-dj` #8B4CF0, `--cr-face-copywriter` #FF9A1F, `--cr-face-designer` #7C8CFF, `--cr-face-web-researcher` #7EDCC0,
  `--cr-face-neutral` #8F8F8F; ring and mouth `--cr-face-ink` #151515

Semantic, white panel surface
- Background: `--cr-color-bg-app`, `-bg-surface`, `-bg-surface-secondary`
  (card header), `-bg-surface-tertiary`, `-bg-fill` (chips),
  `-bg-fill-hover`, `-bg-fill-active`, `-bg-fill-selected` (bubble, selected
  row, active tab), `-bg-fill-brand` (primary button), `-bg-fill-brand-hover`,
  `-bg-skeleton`
- Text: `--cr-color-text`, `-text-secondary`, `-text-tertiary`,
  `-text-emphasis` (read items), `-text-on-fill`, `-text-link`, `-text-info`,
  `-text-success`, `-text-caution`, `-text-critical`
- Border: `--cr-color-border` (cards, secondary buttons), `-border-subtle`
  (dividers), `-border-faint` (rows inside a card), `-border-control`
  (segmented control), `-border-elevated`, `-border-focus`

Semantic, dark sidebar surface (`*-sidebar-*`)
- `--cr-color-bg-sidebar`, `-bg-sidebar-raised` (New thread),
  `-bg-sidebar-hover`, `-bg-sidebar-selected`, `-border-sidebar`,
  `-border-sidebar-divider`, `-text-sidebar`, `-text-sidebar-strong`,
  `-text-sidebar-muted`, `-text-sidebar-secondary`, `-dot-unread-sidebar`

Scales
- Space: `--cr-space-0` … `--cr-space-800` (0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 12, 14,
  16, 18, 20, 24, 28, 32 px)
- Radius: `--cr-radius-100` 4px, `150` 5px, `200` 6px, `250` 7px, `300` 8px,
  `350` 9px, `400` 10px, `500` 12px, `600` 14px, `700` 16px, `full`
- Font: `--cr-font-family` (Inter Variable, bundled), sizes `--cr-font-size-275`
  11px … `--cr-font-size-500` 20px (11, 11.5, 12, 12.5, 13, 13.5, 14, 20),
  weights 400/500/600/700, line heights 1.25/1.35/1.5
- Control heights: `--cr-height-control-xs` 26, `-sm` 28, `-md` 30, `-nav` 32,
  `-lg` 34, `-xl` 36, header heights `--cr-height-header` 44 and
  `--cr-height-header-lg` 56
- Shadows: `--cr-shadow-border`, `-border-subtle`, `-card-elevated`,
  `-composer`, `-panel`; focus `--cr-focus-ring`
- Layout: `--cr-width-sidebar` 268px, `--cr-gap-window` 8px,
  `--cr-width-content` 680px, `--cr-width-composer` 720px

## Components (`src/`)

| Component | Used for |
| --- | --- |
| `Box`, `BlockStack`, `InlineStack`, `Spacer` | Layout with token-only padding and gaps |
| `Text` | All type: variants `headingLg/Md/Sm`, `bodyLg/Md/Sm`, `caption`, tones, truncate |
| `Button` | `primary`, `secondary`, `tertiary`, `plain`; sizes `slim`, `medium`, `large`; on light or dark |
| `IconButton` | Icon-only actions with required label; light and dark tone |
| `Icon` | The v5 line icons (Lucide-style, 1.6 stroke) |
| `Badge` | Status chips ("Working · 3m", "Queued", "Interrupted") |
| `Dot`, `Spinner`, `Shimmer` | Unread dot, notification dot, working spinner, shimmering "Thinking" text |
| `Face`, `FaceStack` | Agent faces: colour disc, ink ring and one mouth per role; `state` (idle, working, thinking, needs-you, done) swaps the mouth; neutral fallback |
| `Card`, `CardHeader`, `CardRow`, `CardRowButton`, `CardDetails`, `CardFooter` | Grouped subagent card, approval card, list cards |
| `Panel`, `PanelHeader`, `PanelBody` | The white rounded panes and their 44/56px headers (headers drag the window) |
| `Tabs` | Preview pane tabs |
| `SegmentedControl` | All/Unread, Desktop/Phone |
| `TextField` | Single-line input (answers, search) |
| `Composer` | "Reply, or @ an agent" box with leading/trailing slots, auto-grow |
| `ChipSelect` | The "GM ⌄" agent chip (native select underneath: keyboard and screen reader for free) |
| `ListItem` | Two-line rows in the sidebar (dark) and Inbox list (light) |
| `NavItem` | Sidebar navigation rows with count and dot |
| `Banner` | Offline notice |
| `Disclosure` | "Worked 6s ›" style collapsible rows |

## Rules for the app

- `apps/mac` styles only with `var(--cr-*)` tokens; `app.css` holds layout and
  Markdown styling, nothing else. A grep for hex colours and raw `px` values in
  `apps/mac/src` should come back empty (1px hairlines live in `@crew/ui`).
- Component resets use `:where()` so they never out-rank component classes.
- Interactive elements are real `<button>`/`<select>`/`<input>`; states come from
  `:hover`, `:active`, `:focus-visible`, `[disabled]`, `aria-pressed`,
  `aria-selected`, `aria-current` and `aria-expanded`, not from JS classes.
- Status is never colour alone: chips carry words ("Interrupted"), the unread
  dot has a label, and faces have the role name as their accessible name.
