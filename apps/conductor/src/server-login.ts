// Signing an engine (or Shopify) in on a server, from the app. There is no
// Terminal to open there, so the conductor runs the CLI's own login in a
// pseudo-terminal (`script`) and hands the app what the person needs: the
// link to open, a one-time code to enter, whether it waits for a pasted code,
// and the 127.0.0.1 port a browser sign-in returns to (the app catches that
// on the person's Mac and passes it on, see /api/logins/<id>/input).

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { ServerLogin } from '@crew/protocol';

const TIMEOUT = 15 * 60_000;

interface Login {
  state: ServerLogin;
  proc: ChildProcess;
  out: string;
}

const logins = new Map<string, Login>();

/** Terminal colours, cursor moves and OSC 8 hyperlinks, which hide or duplicate the URL. */
function plain(s: string): string {
  return s
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function read(login: Login): void {
  const text = plain(login.out);
  const s = login.state;
  s.url ??= text.match(/https:\/\/[^\s'"<>]+/)?.[0];
  s.code ??= text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0];
  s.needsInput = /paste (the )?code|enter (the )?code|code here/i.test(text) && !s.code;
  if (s.url && s.callbackPort === undefined) {
    try {
      const back = new URL(new URL(s.url).searchParams.get('redirect_uri') ?? '');
      if (['127.0.0.1', 'localhost'].includes(back.hostname) && back.port) s.callbackPort = Number(back.port);
    } catch {}
  }
  s.output = text.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
}

/** Starts a login script for a connection; one at a time per connection. */
export function startLogin(connection: string, label: string, script: string): ServerLogin {
  for (const l of logins.values()) if (l.state.connection === connection && !l.state.done) l.proc.kill('SIGTERM');
  const id = randomBytes(12).toString('base64url');
  const proc = spawn('script', ['-qfec', `bash -lc ${JSON.stringify(script)}`, '/dev/null'], {
    env: { ...process.env, TERM: 'dumb', BROWSER: 'false' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const login: Login = { state: { id, connection, label, needsInput: false, done: false }, proc, out: '' };
  logins.set(id, login);
  const take = (d: Buffer) => {
    login.out = (login.out + d.toString('utf8')).slice(-20_000);
    read(login);
  };
  proc.stdout?.on('data', take);
  proc.stderr?.on('data', take);
  const timer = setTimeout(() => proc.kill('SIGTERM'), TIMEOUT);
  proc.on('close', (code) => {
    clearTimeout(timer);
    login.state.done = true;
    login.state.ok = code === 0 && !/that did not work/i.test(plain(login.out));
    // Forget it a while after it ended.
    setTimeout(() => logins.delete(id), 10 * 60_000).unref();
  });
  return login.state;
}

export function loginState(id: string): ServerLogin | undefined {
  return logins.get(id)?.state;
}

/**
 * What the person hands back: a pasted code (typed into the CLI), or the
 * 127.0.0.1 address their browser was sent back to (fetched here, on the
 * server, where the CLI is listening for it).
 */
export async function loginInput(id: string, text: string): Promise<void> {
  const login = logins.get(id);
  if (!login || login.state.done) throw new Error('This sign-in has ended. Start it again.');
  const t = text.trim();
  const back = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\//.exec(t);
  if (back) {
    if (Number(back[2]) !== login.state.callbackPort) throw new Error('That address is not for this sign-in.');
    await fetch(t.replace('//localhost:', '//127.0.0.1:'), { redirect: 'manual' }).catch(() => undefined);
    return;
  }
  if (!t || t.length > 2000) throw new Error('Paste the code from the sign-in page.');
  login.proc.stdin?.write(`${t}\r`);
}

export function cancelLogin(id: string): void {
  logins.get(id)?.proc.kill('SIGTERM');
}
