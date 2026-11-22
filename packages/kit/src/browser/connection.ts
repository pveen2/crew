import { fileURLToPath } from 'node:url';
import { defineConnection } from '@crew/sdk/define';

// A headless browser (https://agent-browser.dev, `agent-browser mcp`) for pages
// that plain web fetch cannot read: forms, calculators, JavaScript-only sites.
// Defined once here; an agent opts in with a one-line connections/browser.ts.
//
// Safety lives in three places:
// - The allow-list below: no JavaScript eval, no saved logins or profiles, no
//   uploads, no screenshots or files on disk, no network or cookie tools.
// - config.json: page text comes back wrapped in boundary markers and capped
//   in size, so a page is harder to mistake for instructions.
// - Who gets it: never an agent that also holds store or customer data. A page
//   could talk such an agent into sending that data out.
//
// An agent with a connection has web search and fetch off by default; set
// `webAccess: true` in its agent.ts if it should have both.

const READ = [
  'agent_browser_open',
  'agent_browser_read',
  'agent_browser_snapshot',
  'agent_browser_get_text',
  'agent_browser_get_url',
  'agent_browser_get_title',
  'agent_browser_scroll',
  'agent_browser_wait_ms',
  'agent_browser_wait_for_selector',
  'agent_browser_wait_for_text',
  'agent_browser_wait_for_load',
  'agent_browser_back',
  'agent_browser_forward',
  'agent_browser_reload',
  'agent_browser_close',
];

/** Clicking and filling in forms: needed for calculators, filters and cookie banners. */
const INTERACT = [
  'agent_browser_click',
  'agent_browser_fill',
  'agent_browser_type',
  'agent_browser_press',
  'agent_browser_check',
  'agent_browser_uncheck',
  'agent_browser_select',
];

export interface BrowserOptions {
  /** Browser session name. Give each agent its own so they do not share tabs or cookies. */
  session: string;
  /** Only these domains (and their subdomains) can be reached, e.g. ['facebook.com']. Default: the open web. */
  allowedDomains?: string[];
  /** false = look only: no clicking or typing. Default true. */
  interact?: boolean;
}

export const browserConnection = (opts: BrowserOptions) =>
  defineConnection({
    description:
      'Headless browser for pages that web fetch cannot read (forms, calculators, JavaScript-only pages)' +
      (opts.allowedDomains?.length ? `, limited to ${opts.allowedDomains.join(', ')}` : ''),
    command: 'agent-browser',
    args: ['mcp', '--config', fileURLToPath(new URL('./config.json', import.meta.url))],
    env: {
      AGENT_BROWSER_SESSION: `crew-${opts.session}`,
      ...(opts.allowedDomains?.length
        ? { AGENT_BROWSER_ALLOWED_DOMAINS: opts.allowedDomains.flatMap((d) => [d, `*.${d}`]).join(',') }
        : {}),
    },
    toolTimeoutSec: 120,
    tools: { allow: [...READ, ...(opts.interact === false ? [] : INTERACT)] },
  });
