import type { ReactNode } from 'react';
import type { InboxItem } from '@crew/protocol';
import { BlockStack, Button, Card, Disclosure, InlineStack, Text } from '@crew/ui';
import { decideApproval } from '../store';
import { Markdown, RoleFace, useRoleLabel } from './common';

/** Deny, the "always" choices (not for ask-every-time tools), and Approve. Shared by the Inbox and the thread. */
export function ApprovalActions({ item }: { item: InboxItem }) {
  return (
    <>
      <Button onClick={() => void decideApproval(item.id, false)}>Deny</Button>
      {item.askEveryTime ? null : (
        <>
          <Button onClick={() => void decideApproval(item.id, true, 'tool')}>Always allow this tool</Button>
          <Button onClick={() => void decideApproval(item.id, true, 'all')}>Approve all in this thread</Button>
        </>
      )}
      <Button variant="primary" onClick={() => void decideApproval(item.id, true)}>
        Approve
      </Button>
    </>
  );
}

/**
 * An approval waiting on the owner, in the thread itself: the same item as in the
 * Inbox, decided from either place. `extra`: a button before the actions, e.g. Step in.
 */
export function ApprovalCard({ item, extra }: { item: InboxItem; extra?: ReactNode }) {
  const label = useRoleLabel(item.role);
  return (
    <Card variant="elevated">
      <BlockStack gap="250">
        <InlineStack gap="150">
          {item.role ? <RoleFace role={item.role} size="xs" decorative /> : null}
          <Text variant="label" tone="secondary">
            {label ? `${label} needs your approval` : 'Needs your approval'}
          </Text>
        </InlineStack>
        <Text variant="bodyLg" weight="medium">
          {item.title}
        </Text>
        <Disclosure summary="What it wants to run">
          <Markdown text={item.body} />
        </Disclosure>
        <InlineStack gap="200" wrap className="inbox-card-actions">
          {extra}
          <span className="cr-spacer" />
          <ApprovalActions item={item} />
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
