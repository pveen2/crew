import { useEffect, useState } from 'react';
import { BlockStack, Button, Card, Icon, InlineStack, Panel, SegmentedControl, Switch, Text } from '@crew/ui';
import { MAC_INSTALL_COMMAND, MAC_RELEASES, latestMacDownloads, offerMacApp, type MacDownloads } from '../macApp';
import { setShowSpend, setSidebarTheme, setTouchIcon, useApp, type SidebarTheme } from '../store';
import type { TouchIcon } from '../touchIcon';

const SIDEBAR_THEMES: Array<{ value: SidebarTheme; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Sand' },
];

/** App preferences. Kept on this Mac. */
export function SettingsView() {
  const showSpend = useApp((s) => s.showSpend);
  const sidebarTheme = useApp((s) => s.sidebarTheme);
  const touchIcon = useApp((s) => s.touchIcon);

  return (
    <Panel as="main" className="pane-main pane-page">
      <div className="page-drag cr-drag" />
      <div className="pane-scroll">
        <BlockStack gap="700" className="page">
          <BlockStack>
            <Text variant="headingLg">Settings</Text>
            <Text variant="bodyMd" tone="secondary">
              How Crew looks on this Mac.
            </Text>
          </BlockStack>

          {offerMacApp && <MacAppCard />}

          <Card>
            <InlineStack gap="400" className="settings-row">
              <BlockStack className="settings-row__text">
                <Text id="setting-sidebar" variant="bodyLg" weight="medium">
                  Sidebar
                </Text>
                <Text variant="bodySm" tone="secondary">
                  Dark, or a light sand colour next to the white page.
                </Text>
              </BlockStack>
              <SegmentedControl label="Sidebar" items={SIDEBAR_THEMES} value={sidebarTheme} onValueChange={setSidebarTheme} />
            </InlineStack>
          </Card>

          <Card>
            <InlineStack gap="400" className="settings-row">
              <BlockStack className="settings-row__text">
                <Text id="setting-spend" variant="bodyLg" weight="medium">
                  Show spend
                </Text>
                <Text id="setting-spend-help" variant="bodySm" tone="secondary">
                  What each thread and agent used, in the sidebar, the thread header and on specialist cards. Agents run on your
                  subscriptions, so this is what the work would cost at API prices, not what you are billed.
                </Text>
              </BlockStack>
              <Switch checked={showSpend} onChange={setShowSpend} labelledBy="setting-spend" describedBy="setting-spend-help" />
            </InlineStack>
          </Card>

          {!window.crewHost && (
            <Card>
              <InlineStack gap="400" className="settings-row">
                <BlockStack className="settings-row__text">
                  <Text variant="bodyLg" weight="medium">
                    Home screen icon
                  </Text>
                  <Text variant="bodySm" tone="secondary">
                    The icon your phone uses when you add Crew to the home screen. After changing it, remove Crew from the
                    home screen and add it again.
                  </Text>
                </BlockStack>
                <SegmentedControl<TouchIcon>
                  label="Home screen icon"
                  value={touchIcon}
                  onValueChange={setTouchIcon}
                  items={[
                    { value: 'orange', label: 'Orange' },
                    { value: 'brunette', label: 'Brunette' },
                  ]}
                />
              </InlineStack>
            </Card>
          )}
        </BlockStack>
      </div>
    </Panel>
  );
}

/** In the browser on a Mac: get the app, the easy way or the download. */
function MacAppCard() {
  const [copied, setCopied] = useState(false);
  const [downloads, setDownloads] = useState<MacDownloads | null>(null);
  useEffect(() => void latestMacDownloads().then(setDownloads), []);
  const copy = () =>
    void navigator.clipboard.writeText(MAC_INSTALL_COMMAND).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });

  return (
    <Card>
      <BlockStack gap="300" className="settings-row">
        <BlockStack>
          <Text variant="bodyLg" weight="medium">
            Crew for Mac
          </Text>
          <Text variant="bodySm" tone="secondary">
            The easiest way: paste this in Terminal. It installs the latest version in Applications and opens it, with no
            security prompts. Run it again to update.
          </Text>
        </BlockStack>
        <InlineStack gap="200" className="mac-install">
          <code className="mac-install__command">{MAC_INSTALL_COMMAND}</code>
          <Button size="slim" icon={copied ? 'checkCircle' : 'copy'} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </InlineStack>
        <Text variant="bodySm" tone="secondary">
          Or download it. macOS then asks once: open Crew, click Done, and allow it in System Settings → Privacy & Security
          → Open Anyway.
        </Text>
        <InlineStack gap="200">
          {/* Until GitHub answers (or if it can't be reached), both go to the release page. */}
          <a className="cr-button cr-button--secondary cr-button--slim" href={downloads?.arm64 ?? MAC_RELEASES}>
            <Icon name="download" size={13} />
            Apple silicon (M1 and later)
          </a>
          <a className="cr-button cr-button--secondary cr-button--slim" href={downloads?.x64 ?? MAC_RELEASES}>
            <Icon name="download" size={13} />
            Intel
          </a>
          <a className="cr-button cr-button--plain cr-button--slim" href={MAC_RELEASES} target="_blank" rel="noreferrer">
            {downloads ? `Version ${downloads.version} · all versions` : 'All versions'}
          </a>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
