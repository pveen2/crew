import { BlockStack, Card, InlineStack, Panel, Switch, Text } from '@crew/ui';
import { setShowSpend, useApp } from '../store';

/** App preferences. Kept on this Mac. */
export function SettingsView() {
  const showSpend = useApp((s) => s.showSpend);

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
        </BlockStack>
      </div>
    </Panel>
  );
}
