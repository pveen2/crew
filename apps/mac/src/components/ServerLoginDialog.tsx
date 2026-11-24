import { useEffect, useRef, useState } from 'react';
import { Banner, BlockStack, Button, InlineStack, Spinner, Text, TextField } from '@crew/ui';
import { closeServerLogin, sendLoginCode, useApp } from '../store';

/**
 * A tool signing in on the team's server. The sign-in page opens in the
 * browser; here the person sees the code to enter, pastes a code back, or just
 * waits while the browser's return is passed on to the server.
 */
export function ServerLoginDialog() {
  const login = useApp((s) => s.serverLogin);
  const error = useApp((s) => s.serverLoginError);
  const ref = useRef<HTMLDialogElement>(null);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (login && d && !d.open) d.showModal();
    if (!login && d?.open) d.close();
    if (!login) {
      setCode('');
      setSent(false);
    }
  }, [login]);

  // Close a little after it worked.
  useEffect(() => {
    if (login?.done && login.ok) {
      const t = window.setTimeout(closeServerLogin, 1500);
      return () => window.clearTimeout(t);
    }
  }, [login?.done, login?.ok]);

  if (!login) return <dialog ref={ref} className="server-login" />;

  const status = login.done
    ? login.ok
      ? `${login.label} is signed in on the server.`
      : `${login.label} did not sign in.`
    : !login.url
      ? 'Starting the sign-in on the server…'
      : login.code
        ? 'Enter this code on the page that opened in your browser:'
        : login.needsInput
          ? 'Sign in on the page that opened in your browser, then paste the code it shows:'
          : 'Sign in on the page that opened in your browser. This closes when it is done.';

  return (
    <dialog ref={ref} className="server-login" onCancel={(e) => (e.preventDefault(), closeServerLogin())}>
      <BlockStack gap="400">
        <Text variant="headingMd">Sign in {login.label} for the team</Text>
        <InlineStack gap="200" blockAlign="center">
          {!login.done && <Spinner size={12} label="Waiting" />}
          <Text tone={login.done && !login.ok ? 'critical' : undefined}>{status}</Text>
        </InlineStack>

        {login.code && !login.done && <div className="server-login-code">{login.code}</div>}

        {login.needsInput && !login.done && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!code.trim()) return;
              setSent(true);
              void sendLoginCode(code);
            }}
          >
            <InlineStack gap="200" blockAlign="end">
              <TextField label="Code" showLabel value={code} onChange={setCode} autoFocus className="grow" placeholder="Paste the code" />
              <Button type="submit" variant="primary" disabled={!code.trim() || sent}>
                {sent ? 'Sent' : 'Send'}
              </Button>
            </InlineStack>
          </form>
        )}

        {login.url && !login.done && (
          <Text variant="caption" tone="secondary">
            No page?{' '}
            <a href={login.url} onClick={(e) => (e.preventDefault(), void window.crewHost?.openExternal?.(login.url!))}>
              Open the sign-in page
            </a>
            . It signs the tool in on the server, for everyone on the team.
          </Text>
        )}

        {error && <Banner tone="critical">{error}</Banner>}
        {login.done && !login.ok && login.output && <pre className="server-login-output">{login.output}</pre>}

        <InlineStack gap="200" align="end">
          <Button onClick={closeServerLogin}>{login.done ? 'Close' : 'Cancel'}</Button>
        </InlineStack>
      </BlockStack>
    </dialog>
  );
}
