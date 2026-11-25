import { useState, type ReactNode } from 'react';
import type { InboxItem } from '@crew/protocol';
import { BlockStack, Button, Card, Disclosure, InlineStack, Text } from '@crew/ui';
import { decideApproval } from '../store';
import { Markdown, RoleFace, useRoleLabel } from './common';

/** Deny, the "always" choices (not for ask-every-time tools), and Approve. Shared by the Inbox and the thread. */
export function ApprovalActions({ item }: { item: InboxItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (approved: boolean, always?: 'tool' | 'all') => {
    setBusy(true);
    setError('');
    try {
      await decideApproval(item.id, approved, always);
    } catch (err) {
      setError((err as Error).message || 'Could not send your decision. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error ? (
        <Text as="span" variant="bodySm" tone="critical" role="alert">
          {error}
        </Text>
      ) : null}
      <Button disabled={busy} onClick={() => void decide(false)}>
        Deny
      </Button>
      {item.askEveryTime ? null : (
        <>
          <Button disabled={busy} onClick={() => void decide(true, 'tool')}>
            Always allow this tool
          </Button>
          <Button disabled={busy} onClick={() => void decide(true, 'all')}>
            Approve all in this thread
          </Button>
        </>
      )}
      <Button variant="primary" disabled={busy} onClick={() => void decide(true)}>
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
