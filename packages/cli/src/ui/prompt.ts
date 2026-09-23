import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { claimTerminal, releaseTerminal } from './terminal.js';

/**
 * Ask a yes/no question on the terminal. Only "y"/"yes"/"是" (case-insensitive) count as yes;
 * empty input, EOF (closed/non-interactive stdin), Ctrl-C and an aborted `signal` count as no.
 */
export function confirm(
  question: string,
  opts: { output?: NodeJS.WriteStream; signal?: AbortSignal } = {},
): Promise<boolean> {
  const output = opts.output ?? process.stdout;
  const { signal } = opts;
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY && output.isTTY) });
    let settled = false;
    const onAbort = () => {
      output.write('\n');
      finish(false);
    };
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      rl.close();
      resolve(answer);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    rl.on('SIGINT', () => {
      output.write('\n');
      finish(false);
    });
    rl.on('close', () => finish(false));
    rl.question(question, (answer) => finish(isYes(answer)));
  });
}

export function isYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes' || a === '是';
}

/**
 * Show long text on `output` (default stdout): piped through a pager (`$PAGER` or `less`) when that
 * stream and stdin are terminals and the text does not fit on one screen; printed directly otherwise
 * (or if the pager cannot be started).
 */
export async function pageText(text: string, opts: { force?: boolean; output?: NodeJS.WriteStream } = {}): Promise<void> {
  const output = opts.output ?? process.stdout;
  const body = text.endsWith('\n') ? text : text + '\n';
  const rows = output.rows || 24;
  const lineCount = body.split('\n').length;
  const long = opts.force || lineCount > rows - 4;
  if (!output.isTTY || !process.stdin.isTTY || !long) {
    output.write(body);
    return;
  }
  const paged = await runPager(body, output);
  if (!paged) output.write(body);
}

function pagerCommand(): { cmd: string; args: string[] } {
  const env = process.env.PAGER?.trim();
  if (env) {
    const parts = env.split(/\s+/);
    return { cmd: parts[0]!, args: parts.slice(1) };
  }
  // -X: leave the text on screen after quitting; -R: pass colours through; -K: Ctrl-C quits the pager
  // (plain less ignores it, so an impatient second Ctrl-C would otherwise be the only way out).
  return { cmd: 'less', args: ['-X', '-R', '-K'] };
}

/** Resolves true when the pager ran (and exited), false when it could not be started. */
function runPager(text: string, output: NodeJS.WriteStream): Promise<boolean> {
  const { cmd, args } = pagerCommand();
  return new Promise<boolean>((resolve) => {
    // The pager owns the terminal: node must not die from the Ctrl-C meant for it (the listener keeps
    // SIGINT's default action away), and withManager defers its interrupt handling until the pager is
    // gone (see ui/terminal.ts) so a second Ctrl-C cannot force-exit and orphan the pager.
    const ignore = () => {};
    process.on('SIGINT', ignore);
    let child: ChildProcess | undefined;
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', ignore);
      if (child) releaseTerminal();
      resolve(ok);
    };
    try {
      child = spawn(cmd, args, {
        // The pager writes to the stream we talk to the user on (stderr when stdout is redirected).
        stdio: ['pipe', output === process.stdout ? 'inherit' : output, 'inherit'],
        env: { LESSCHARSET: 'utf-8', ...process.env },
      });
    } catch {
      child = undefined;
      done(false);
      return;
    }
    claimTerminal(child);
    let started = false;
    child.on('spawn', () => {
      started = true;
    });
    child.on('error', () => {
      if (!started) done(false);
    });
    child.on('exit', () => done(true));
    child.stdin?.on('error', () => {
      // EPIPE when the user quits the pager before reading everything.
    });
    child.stdin?.end(text);
  });
}
