// Spawns a CLI, feeds the prompt on stdin and hands each JSON line of stdout
// to a parser. With keepStdinOpen the adapter gets a handle to write more lines
// while the CLI runs (steering, JSON-RPC) and closes stdin itself.

import { spawn } from 'node:child_process';
import { AGENT_ENV_ALLOW } from '../config.ts';

export interface JsonlRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  stderrTail: string;
}

/** Only the basics an agent CLI needs from the parent environment (an allowlist). */
export function agentBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && AGENT_ENV_ALLOW.test(k)) env[k] = v;
  }
  return env;
}

export interface StdinHandle {
  /** Writes one line. False once stdin is closed. */
  write(line: string): boolean;
  end(): void;
}

export function runJsonl(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  signal: AbortSignal;
  onLine: (obj: Record<string, unknown>) => void;
  /** Called with the process id once started, so a restarted conductor can clean up orphans. */
  onSpawn?: (pid: number) => void;
  /** Leave stdin open after the first write; the adapter ends it through onStdin. */
  keepStdinOpen?: boolean;
  onStdin?: (io: StdinHandle) => void;
}): Promise<JsonlRun> {
  return new Promise((resolve) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so the CLI and the MCP servers it started can be stopped together.
      detached: true,
    });
    if (child.pid) opts.onSpawn?.(child.pid);
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };

    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      aborted = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          opts.onLine(JSON.parse(line) as Record<string, unknown>);
        } catch (err) {
          // A bad line must not kill the run.
          console.warn('[engine] could not handle line:', (err as Error).message, line.slice(0, 200));
        }
      }
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on('error', (err) => {
      stderr += `\n${err.message}`;
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(killTimer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve({ exitCode, signal, aborted, stderrTail: stderr.trim() });
    });

    let stdinOpen = true;
    child.stdin.on('error', () => {
      stdinOpen = false;
    });
    child.on('close', () => {
      stdinOpen = false;
    });
    if (opts.keepStdinOpen) {
      child.stdin.write(opts.stdin);
      opts.onStdin?.({
        write(line) {
          if (!stdinOpen) return false;
          child.stdin.write(line.endsWith('\n') ? line : line + '\n');
          return true;
        },
        end() {
          if (!stdinOpen) return;
          stdinOpen = false;
          child.stdin.end();
        },
      });
    } else {
      stdinOpen = false;
      child.stdin.end(opts.stdin);
    }
  });
}

export function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more characters)` : s;
}
