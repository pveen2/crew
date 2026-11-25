import { BlockStack, Card, InlineStack, Panel, SegmentedControl, Switch, Text } from '@crew/ui';
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
