import { useEffect, useRef, useState } from 'react';
import { BlockStack, Button, IconButton, InlineStack, Text } from '@crew/ui';
import { shareThread, unshareThread, useApp } from '../store';
import { ago, useNow } from './common';

/**
 * Share a thread read-only. The link shows the thread as it was when shared (the
 * conversation with the lead, without tool calls); anyone with it can open it,
 * without signing in. Update takes a new snapshot, Stop sharing ends the link.
 * Only on a team server.
 */
export function ShareButton({ threadId }: { threadId: string }) {
  const sharing = useApp((s) => s.sharing);
  const shared = useApp((s) => Boolean(s.shares[threadId]));
  const [open, setOpen] = useState(false);
  if (!sharing) return null;
  return (
    <>
      <Button size="slim" icon="link" className="phone-hide" aria-pressed={shared} onClick={() => setOpen(true)}>
        {shared ? 'Shared' : 'Share'}
      </Button>
      <IconButton icon="link" label="Share" className="phone-only" onClick={() => setOpen(true)} />
      {open && <ShareDialog threadId={threadId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareDialog({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const share = useApp((s) => s.shares[threadId]);
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const now = useNow(30_000);

  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy. Select the link and copy it.');
    }
  };

  return (
    <dialog ref={ref} className="server-login share-dialog" onCancel={(e) => (e.preventDefault(), onClose())} onClose={onClose}>
      <BlockStack gap="400">
        <Text variant="headingMd">Share this thread</Text>
        {share ? (
          <>
            <Text tone="secondary">
              Anyone with the link can read the thread as it was {ago(share.sharedAt, now)}, without signing in. They cannot reply.
              New messages are not shared until you update the link.
            </Text>
            <InlineStack gap="200" blockAlign="center">
              <input className="share-url grow" readOnly value={share.url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
              <Button variant="primary" icon={copied ? 'check' : 'copy'} onClick={() => void copy(share.url)}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </InlineStack>
          </>
        ) : (
          <Text tone="secondary">
            Makes a read-only link to the thread as it is now: your messages, the agent's answers and its Markdown drafts. Tool calls and
            approvals are left out. Anyone with the link can read it, without signing in.
          </Text>
        )}
        {error && <Text tone="critical">{error}</Text>}
        <InlineStack gap="200" align="end">
          {share && (
            <Button variant="tertiary" className="share-stop" disabled={busy} onClick={() => void act(() => unshareThread(threadId))}>
              Stop sharing
            </Button>
          )}
          <span className="cr-spacer" />
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
          {share ? (
            <Button disabled={busy} icon="reload" onClick={() => void act(() => shareThread(threadId))}>
              Update to now
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="link"
              disabled={busy}
              onClick={() => void act(async () => copy((await shareThread(threadId)).url))}
            >
              Create link
            </Button>
          )}
        </InlineStack>
      </BlockStack>
    </dialog>
  );
}
