// The icon an iPhone puts on the home screen when the web app is added.
// The server sits behind Cloudflare Access, and iOS fetches the
// apple-touch-icon without the Access cookie: it gets the login page instead,
// gives up and uses a blurry screenshot of the page. So the icon goes into the
// page itself as a data URL (Vite inlines it), and nothing has to be fetched.
import orange from './assets/touch-icon-orange.png?inline';
import brunette from './assets/touch-icon-brunette.png?inline';

export type TouchIcon = 'orange' | 'brunette';

const ICONS: Record<TouchIcon, string> = { orange, brunette };

export function isTouchIcon(v: unknown): v is TouchIcon {
  return v === 'orange' || v === 'brunette';
}

/** Points the page's apple-touch-icon at the chosen icon. Applies the next time it is added to the home screen. */
export function applyTouchIcon(icon: TouchIcon): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'apple-touch-icon';
    document.head.append(link);
  }
  link.href = ICONS[icon];
}
