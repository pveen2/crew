import { useEffect, useState } from 'react';
import type { SharedItem, SharedThread } from '@crew/protocol';
import { BlockStack, Card, Icon, InlineStack, Shimmer, Text } from '@crew/ui';
import { Markdown } from './common';

/**
 * A shared thread (/s/<token>): read-only, without signing in. The conductor
 * serves this page outside Cloudflare Access; it only ever reads the snapshot
 * the link points at, never the API.
 */
export function SharePage({ token }: { token: string }) {
  const [thread, setThread] = useState<SharedThread | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/s/${token}/data`, { cache: 'no-store' })
      .then(async (res) => {
        const body = (await res.json()) as SharedThread & { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? 'This link does not work any more.');
        setThread(body);
        document.title = `${body.title} · ${body.team}`;
      })
      .catch((err: Error) => setError(err.message === 'Failed to fetch' ? 'Could not load this thread.' : err.message));
  }, [token]);

  return (
    <div className="share-page cr-root">
      <header className="share-header">
        <div className="share-header__inner">
          {thread ? (
            <BlockStack gap="050">
              <Text variant="caption" tone="secondary">
                {thread.team} · shared {new Date(thread.sharedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} · read-only
              </Text>
              <Text as="h1" variant="headingLg" leading="tight">
                {thread.title}
              </Text>
            </BlockStack>
          ) : (
            <Text as="h1" variant="headingLg">
              {error ? 'Shared thread' : <Shimmer>Loading</Shimmer>}
            </Text>
          )}
        </div>
      </header>
      <main className="chat share-chat">
        {error ? (
          <InlineStack gap="200" blockAlign="center">
            <Icon name="alert" size={14} />
            <Text tone="secondary">{error}</Text>
          </InlineStack>
        ) : (
          thread?.items.map((item, i) => <SharedRow key={i} token={token} item={item} previous={thread.items[i - 1]} />)
        )}
      </main>
    </div>
  );
}

function SharedRow({ token, item, previous }: { token: string; item: SharedItem; previous?: SharedItem }) {
  // Name the agent where its part of the conversation starts.
  const byAgent = (i?: SharedItem) => Boolean(i && (i.kind === 'doc' || i.from === 'agent'));
  const agentStarts = byAgent(item) && !byAgent(previous);
  const name = agentStarts && item.agent ? (
    <Text variant="caption" weight="medium" tone="secondary">
      {item.agent}
    </Text>
  ) : null;

  if (item.kind === 'doc') {
    return (
      <BlockStack gap="100">
        {name}
        <Card padded className="share-doc">
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Icon name="document" size={14} />
              <Text as="span" variant="bodyLg" weight="medium">
                {item.title}
              </Text>
            </InlineStack>
            {item.content ? (
              <Markdown text={item.content} />
            ) : (
              <Text variant="bodySm" tone="secondary">
                {item.format === 'html' ? 'A page' : 'A concept board'}, not included in the link.
              </Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    );
  }
  if (item.from === 'person') {
    // Name a person where their messages start, once more than one person wrote.
    const named = item.name && !(previous?.kind === 'message' && previous.from === 'person' && previous.name === item.name);
    return (
      <div className="owner-message">
        {named ? (
          <Text variant="caption" weight="medium" tone="secondary">
            {item.name}
          </Text>
        ) : null}
        <div className="bubble">
          {item.attachments?.length ? (
            <div className="share-images">
              {item.attachments.map((a) => (
                <img key={a.file} src={`/s/${token}/files/${encodeURIComponent(a.file)}`} alt={a.name} loading="lazy" />
              ))}
            </div>
          ) : null}
          <Markdown text={item.text} />
        </div>
      </div>
    );
  }
  return (
    <BlockStack gap="100">
      {name}
      <Markdown text={item.text} />
    </BlockStack>
  );
}
