/** Where the Mac app is downloaded from, for the web app (crew.paul.studio). */
export const MAC_RELEASES = 'https://github.com/pveen2/crew/releases/latest';

export interface MacDownloads {
  version: string;
  arm64?: string;
  x64?: string;
}

/**
 * The DMGs of the latest release, from GitHub's API: Crew-<version>-arm64.dmg
 * and Crew-<version>.dmg (Intel). Null when GitHub can't be reached.
 */
export async function latestMacDownloads(): Promise<MacDownloads | null> {
  try {
    const res = await fetch('https://api.github.com/repos/pveen2/crew/releases/latest');
    if (!res.ok) return null;
    const release = (await res.json()) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
    const find = (re: RegExp) => release.assets.find((a) => re.test(a.name))?.browser_download_url;
    return { version: release.tag_name.replace(/^v/, ''), arm64: find(/^Crew-[\d.]+-arm64\.dmg$/), x64: find(/^Crew-[\d.]+\.dmg$/) };
  } catch {
    return null;
  }
}

/** Installs without the Gatekeeper prompts: curl downloads carry no quarantine flag. */
export const MAC_INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/pveen2/crew/main/scripts/install-mac.sh | bash';

/**
 * In a browser on a Mac, not inside the app. iPads also say "Macintosh" in
 * their user agent, so touch screens are left out.
 */
export const offerMacApp = !window.crewHost && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
