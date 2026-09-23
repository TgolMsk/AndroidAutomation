import type { ChildProcess } from 'node:child_process';

/**
 * Terminal ownership shared by the prompt helpers and the Ctrl-C handling in runtime.ts.
 *
 * While a foreground child such as the license pager owns the terminal, Ctrl-C belongs to it: the
 * interrupt is recorded instead of escalated (a second Ctrl-C must not force-exit node under a live
 * pager, leaving it orphaned on the tty) and is replayed once the child has exited. A forced exit
 * (SIGTERM/SIGHUP escalation) kills the child first.
 */

let owner: ChildProcess | undefined;
let pendingInterrupt = false;
let replay: (() => void) | undefined;

/** A child now owns the terminal (until releaseTerminal()). */
export function claimTerminal(child: ChildProcess): void {
  owner = child;
  pendingInterrupt = false;
}

/** The child gave the terminal back; replays a Ctrl-C that arrived meanwhile. */
export function releaseTerminal(): void {
  owner = undefined;
  if (!pendingInterrupt) return;
  pendingInterrupt = false;
  replay?.();
}

/** Called for SIGINT: returns true (and remembers it) when a foreground child owns the terminal. */
export function deferInterrupt(): boolean {
  if (!owner) return false;
  pendingInterrupt = true;
  return true;
}

/** Handler run by releaseTerminal() for a deferred Ctrl-C (installed by withManager). */
export function setInterruptReplay(fn: (() => void) | undefined): void {
  replay = fn;
}

/** Kill the terminal-owning child (if any) and give it a moment to restore the tty. */
export async function killTerminalChild(waitMs = 1000): Promise<void> {
  const child = owner;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * The stream to talk to the user on for an interactive question: stdout when it is a terminal,
 * otherwise stderr when that is one (e.g. `avdm sdk install > install.log`). `undefined` when stdin
 * is not a terminal or neither output is — the caller must then refuse instead of prompting blind.
 */
export function interactiveOutput(): NodeJS.WriteStream | undefined {
  if (!process.stdin.isTTY) return undefined;
  if (process.stdout.isTTY) return process.stdout;
  if (process.stderr.isTTY) return process.stderr;
  return undefined;
}
