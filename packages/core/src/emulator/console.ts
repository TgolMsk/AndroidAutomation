import { promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AvdmError } from '../errors.js';
import { consoleAuthTokenFile } from '../paths.js';

/**
 * Emulator telnet console client (localhost:<consolePort>).
 * Protocol: on connect the emulator prints a banner ending with "OK\r\n"; if auth is required the banner
 * mentions ".emulator_console_auth_token" — send `auth <token>` (token from consoleAuthTokenFile()).
 * Each command replies with lines ending in "OK" or "KO: <message>".
 * IMPLEMENTER: agent "core-emu" (see docs/DESIGN.md §emulator).
 */

const TOKEN_FILE_BASENAME = '.emulator_console_auth_token';

/**
 * Token file named in the auth banner (the emulator prints the path it reads), falling back to the default
 * location. Only a file literally named `.emulator_console_auth_token` is accepted from the banner.
 */
export function authTokenFileFromBanner(banner: string): string {
  for (const m of banner.matchAll(/'([^'\r\n]+)'/g)) {
    const candidate = m[1]?.trim();
    if (candidate && path.isAbsolute(candidate) && path.basename(candidate) === TOKEN_FILE_BASENAME) return candidate;
  }
  return consoleAuthTokenFile();
}

interface ConsoleResult {
  output: string;
  /** The command line was written to the socket. */
  sent: boolean;
}

type Phase = 'banner' | 'auth' | 'command';

function isOkLine(line: string): boolean {
  return /^OK(?::|\s|$)/.test(line);
}

/** Connect, pass the banner (authenticating if required), run one command, resolve with its output. */
function runConsole(
  port: number,
  command: string,
  timeoutMs: number,
  onSent: () => void,
): Promise<ConsoleResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setEncoding('utf8');
    let phase: Phase = 'banner';
    let pending = '';
    let banner = '';
    const outLines: string[] = [];
    let sent = false;
    let settled = false;
    const isKill = /^kill\b/.test(command.trim());

    const finish = (err: Error | undefined, output = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.destroy();
      if (err) reject(err);
      else resolve({ output, sent });
    };
    const timer = setTimeout(() => {
      if (isKill && sent) finish(undefined, '');
      else finish(new AvdmError('COMMAND_FAILED', `模拟器控制台 127.0.0.1:${port} 响应超时（命令: ${command}）`));
    }, timeoutMs);

    const send = (line: string) => socket.write(`${line}\n`);
    const sendCommand = () => {
      phase = 'command';
      send(command);
      sent = true;
      onSent();
    };

    const onLine = (line: string) => {
      if (phase === 'banner') {
        if (!isOkLine(line)) {
          banner += `${line}\n`;
          return;
        }
        if (/auth_token/i.test(banner)) {
          const file = authTokenFileFromBanner(banner);
          fsp
            .readFile(file, 'utf8')
            .then((token) => {
              if (settled) return;
              phase = 'auth';
              send(`auth ${token.trim()}`);
            })
            .catch((err: Error) =>
              finish(new AvdmError('COMMAND_FAILED', `模拟器控制台需要认证，但无法读取令牌文件 ${file}: ${err.message}`)),
            );
          return;
        }
        sendCommand();
        return;
      }
      if (phase === 'auth') {
        if (line.startsWith('KO')) {
          finish(new AvdmError('COMMAND_FAILED', `模拟器控制台认证失败: ${line.replace(/^KO:?\s*/, '')}`));
        } else if (isOkLine(line)) {
          sendCommand();
        }
        return;
      }
      // phase === 'command'
      if (line.startsWith('KO')) {
        finish(new AvdmError('COMMAND_FAILED', `模拟器控制台命令 "${command}" 失败: ${line.replace(/^KO:?\s*/, '')}`));
      } else if (isOkLine(line)) {
        const rest = line.replace(/^OK:?\s*/, '');
        if (rest) outLines.push(rest);
        finish(undefined, outLines.join('\n'));
      } else {
        outLines.push(line);
      }
    };

    socket.on('data', (chunk: string) => {
      pending += chunk;
      let nl: number;
      while (!settled && (nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        onLine(line);
      }
    });
    socket.on('error', (err) => {
      if (isKill && sent) finish(undefined, outLines.join('\n'));
      else finish(new AvdmError('COMMAND_FAILED', `无法连接模拟器控制台 127.0.0.1:${port}: ${err.message}`));
    });
    socket.on('close', () => {
      // `kill` makes the emulator drop the connection; that is the expected outcome.
      if (isKill && sent) finish(undefined, outLines.join('\n'));
      else finish(new AvdmError('COMMAND_FAILED', `模拟器控制台 127.0.0.1:${port} 连接已关闭（命令: ${command}）`));
    });
  });
}

export async function consoleCommand(port: number, command: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  if (/[\r\n]/.test(command)) throw new AvdmError('INVALID_ARGUMENT', '控制台命令不能包含换行');
  const { output } = await runConsole(port, command, opts.timeoutMs ?? 5000, () => {});
  return output;
}

/** Send `kill` (graceful shutdown; Quick Boot snapshot save happens here). Resolves true if the command was sent. */
export async function consoleKill(port: number, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  let sent = false;
  try {
    await runConsole(port, 'kill', opts.timeoutMs ?? 5000, () => {
      sent = true;
    });
    return true;
  } catch {
    return sent;
  }
}
