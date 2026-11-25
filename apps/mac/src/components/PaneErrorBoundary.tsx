import { Component, type ReactNode } from 'react';
import { BlockStack, Button, Icon, Panel, Text } from '@crew/ui';

/**
 * Keeps one broken view from blanking the whole window. Without it, an error while rendering
 * a pane unmounts the app and leaves an empty dark window. Keyed on the view in App, so going
 * to another view starts fresh.
 */
export class PaneErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown) {
    console.error('[crew] view crashed', error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Panel as="main" className="pane-main" aria-label="Error">
        <div className="pane-center">
          <BlockStack gap="200" inlineAlign="center">
            <Icon name="alert" size={16} />
            <Text>This view ran into a problem.</Text>
            <Text variant="bodySm" tone="tertiary">
              {error.message}
            </Text>
            <Text variant="bodySm" tone="secondary">
              If this keeps happening, update Crew.
            </Text>
            <Button onClick={() => this.setState({ error: null })}>Try again</Button>
          </BlockStack>
        </div>
      </Panel>
    );
  }
}
