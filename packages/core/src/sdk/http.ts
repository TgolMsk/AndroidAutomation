import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AvdmError } from '../errors.js';
import { ensureDir } from '../util/fs.js';
import { execFileText } from '../util/proc.js';

/**
 * HTTP via the system `curl` (always present on macOS). Reasons: honours proxy env vars,
 * supports resume, and needs no Node proxy agent. When no proxy env var is set, the macOS
 * system proxy (scutil --proxy) is used so the Electron app launched from Finder still works.
 * IMPLEMENTER: agent "core-sdk".
 */

const CURL_BIN = process.platform === 'darwin' ? '/usr/bin/curl' : process.platform === 'win32' ? 'curl.exe' : 'curl';

/** Hosts that must never go through a proxy (local mirrors, test servers). */
const ALWAYS_NO_PROXY = ['localhost', '127.0.0.1'];

// ───────────────────────────── Proxy resolution ─────────────────────────────

export interface ScutilProxyInfo {
  /** Scalar keys of the top-level dictionary, e.g. { HTTPEnable: '1', HTTPProxy: '127.0.0.1', … }. */
  values: Record<string, string>;
  /** ExceptionsList entries (bypass hosts). */
  exceptions: string[];
}

/**
 * Parse the output of `scutil --proxy`:
 * ```
 * <dictionary> {
 *   ExceptionsList : <array> {
 *     0 : 127.0.0.1
 *   }
 *   HTTPEnable : 1
 *   HTTPPort : 6152
 *   HTTPProxy : 127.0.0.1
 * }
 * ```
 */
export function parseScutilProxy(text: string): ScutilProxyInfo {
  const values: Record<string, string> = {};
  const exceptions: string[] = [];
  // Stack of open containers; depth 1 = the top-level dictionary.
  const stack: string[] = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === '}') {
      stack.pop();
      continue;
    }
    if (/^<(dictionary|array)>\s*\{$/.test(line)) {
      stack.push('root');
      continue;
    }
    const m = /^([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] as string).trim();
    const value = (m[2] as string).trim();
    const opens = /^<(dictionary|array)>\s*\{$/.test(value);
    if (stack.length === 1) {
      if (opens) stack.push(key);
      else values[key] = value;
      continue;
    }
    if (stack.length === 2 && stack[1] === 'ExceptionsList' && !opens) {
      if (value) exceptions.push(value);
      continue;
    }
    if (opens) stack.push(key);
  }
  return { values, exceptions };
}

function hostPort(host: string | undefined, port: string | undefined): string | undefined {
  const h = host?.trim();
  if (!h) return undefined;
  const hh = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
  const p = port?.trim();
  return p && /^\d+$/.test(p) && p !== '0' ? `${hh}:${p}` : hh;
}

function mergeNoProxy(...lists: Array<string | string[] | undefined>): string {
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    const items = Array.isArray(list) ? list : list.split(',');
    for (let item of items) {
      item = item.trim();
      if (!item || /\s/.test(item) || item === '<local>') continue;
      // curl understands ".local" (domain suffix) rather than the macOS "*.local" form.
      if (item.startsWith('*.')) item = item.slice(1);
      if (!out.includes(item)) out.push(item);
    }
  }
  return out.join(',');
}

function withNoProxy(env: Record<string, string>, extra?: string | string[]): Record<string, string> {
  const np = mergeNoProxy(ALWAYS_NO_PROXY, extra);
  env.NO_PROXY = np;
  env.no_proxy = np;
  return env;
}

/**
 * Proxy env from the scutil --proxy output (pure). HTTPS proxy when HTTPSEnable=1, otherwise the HTTP proxy
 * (both are plain HTTP proxies, so the URL scheme is http://); SOCKS as a last resort. Returns undefined when
 * no proxy is enabled.
 */
export function proxyEnvFromScutil(text: string): Record<string, string> | undefined {
  const { values, exceptions } = parseScutilProxy(text);
  const on = (k: string) => values[k] === '1';
  const https = on('HTTPSEnable') ? hostPort(values.HTTPSProxy, values.HTTPSPort) : undefined;
  const http = on('HTTPEnable') ? hostPort(values.HTTPProxy, values.HTTPPort) : undefined;
  const socks = on('SOCKSEnable') ? hostPort(values.SOCKSProxy, values.SOCKSPort) : undefined;
  const env: Record<string, string> = {};
  const httpsUrl = https ?? http;
  const httpUrl = http ?? https;
  if (httpsUrl) {
    env.HTTPS_PROXY = env.https_proxy = `http://${httpsUrl}`;
  }
  if (httpUrl) {
    env.HTTP_PROXY = env.http_proxy = `http://${httpUrl}`;
  }
  if (!httpsUrl && !httpUrl && socks) {
    env.ALL_PROXY = env.all_proxy = `socks5h://${socks}`;
  }
  if (!Object.keys(env).length) return undefined;
  return withNoProxy(env, exceptions);
}

/**
 * Proxy env derived from an existing environment (pure). Returns undefined when it has no proxy variables.
 * curl ignores upper-case HTTP_PROXY and only honours http_proxy, so both spellings are emitted; an
 * http-only proxy is also used for https (the manifests and archives are https).
 */
export function proxyEnvFromEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = env[k]?.trim();
      if (v) return v;
    }
    return undefined;
  };
  const https = pick('https_proxy', 'HTTPS_PROXY');
  const http = pick('http_proxy', 'HTTP_PROXY');
  const all = pick('all_proxy', 'ALL_PROXY');
  if (!https && !http && !all) return undefined;
  const out: Record<string, string> = {};
  const httpsUrl = https ?? http;
  if (httpsUrl) out.HTTPS_PROXY = out.https_proxy = httpsUrl;
  if (http) out.HTTP_PROXY = out.http_proxy = http;
  if (all) out.ALL_PROXY = out.all_proxy = all;
  return withNoProxy(out, pick('no_proxy', 'NO_PROXY'));
}

/** Proxy env vars to pass to curl (HTTPS_PROXY/HTTP_PROXY/NO_PROXY), from env or macOS scutil. */
export async function resolveProxyEnv(): Promise<Record<string, string>> {
  const fromEnv = proxyEnvFromEnv(process.env);
  if (fromEnv) return fromEnv;
  if (process.platform === 'darwin') {
    try {
      const out = await execFileText('/usr/sbin/scutil', ['--proxy'], { timeoutMs: 5_000 });
      const fromSystem = proxyEnvFromScutil(out);
      if (fromSystem) return fromSystem;
    } catch {
      // scutil unavailable: go direct
    }
  }
  return {};
}

// ───────────────────────────── curl runner ─────────────────────────────

interface CurlResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

const CURL_ERRORS: Record<number, string> = {
  3: 'URL 格式错误',
  5: '无法解析代理服务器地址',
  6: '无法解析主机名，请检查网络或代理设置',
  7: '无法连接到服务器，请检查网络或代理设置',
  18: '传输中断，文件不完整',
  22: '服务器返回 HTTP 错误',
  23: '写入本地文件失败（磁盘已满或无权限？）',
  26: '读取本地文件失败',
  28: '连接或传输超时',
  33: '服务器不支持断点续传',
  35: 'SSL/TLS 握手失败',
  37: '无法读取文件',
  47: '重定向次数过多',
  52: '服务器没有返回任何数据',
  55: '发送数据失败',
  56: '接收数据失败（网络中断）',
  60: '服务器证书校验失败',
  97: '代理握手失败',
};

function describeCurlFailure(url: string, r: CurlResult): string {
  const reason = r.code !== null ? CURL_ERRORS[r.code] ?? `curl 退出码 ${r.code}` : `curl 被信号 ${r.signal} 终止`;
  const detail = r.stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return `下载失败: ${url}（${reason}${detail ? `；${detail}` : ''}）`;
}

async function curlEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, ...(await resolveProxyEnv()) };
}

/** Run curl; resolves with the exit status (never rejects on non-zero exit). Abort kills curl and rejects. */
function runCurl(
  args: string[],
  opts: { env: NodeJS.ProcessEnv; signal?: AbortSignal; captureStdout: boolean; url: string },
): Promise<CurlResult> {
  return new Promise((resolve, reject) => {
    const cancelled = () => new AvdmError('DOWNLOAD_FAILED', `下载已取消: ${opts.url}`);
    if (opts.signal?.aborted) {
      reject(cancelled());
      return;
    }
    const child = spawn(CURL_BIN, args, {
      env: opts.env,
      stdio: ['ignore', opts.captureStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8');
      if (err.length > 16_384) err = err.slice(-8_192);
    });
    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      killTimer.unref();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: NodeJS.ErrnoException) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(
        new AvdmError(
          'DOWNLOAD_FAILED',
          e.code === 'ENOENT' ? `找不到 curl（${CURL_BIN}），无法下载` : `启动 curl 失败: ${e.message}`,
        ),
      );
    });
    child.on('close', (code, signal) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (aborted) {
        reject(cancelled());
        return;
      }
      resolve({ code, signal, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

const COMMON_ARGS = ['--silent', '--show-error', '--fail', '--location', '--retry', '3', '--connect-timeout', '30'];

export async function httpGetText(url: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  const timeoutSec = Math.max(1, Math.ceil((opts.timeoutMs ?? 120_000) / 1000));
  const args = [...COMMON_ARGS, '--compressed', '--max-time', String(timeoutSec), url];
  const runOpts: Parameters<typeof runCurl>[1] = { env: await curlEnv(), captureStdout: true, url };
  if (opts.signal) runOpts.signal = opts.signal;
  const r = await runCurl(args, runOpts);
  if (r.code !== 0) throw new AvdmError('DOWNLOAD_FAILED', describeCurlFailure(url, r), { exitCode: r.code });
  return r.stdout.toString('utf8');
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * Download `url` to `destFile` (resuming a partial `destFile.part` if present), reporting progress by
 * polling the part file size every ~300ms. Renames .part → destFile on success.
 */
export async function httpDownload(
  url: string,
  destFile: string,
  opts: {
    expectedSize?: number;
    signal?: AbortSignal;
    onProgress?: (receivedBytes: number, totalBytes?: number) => void;
  } = {},
): Promise<void> {
  const part = `${destFile}.part`;
  await ensureDir(path.dirname(destFile));
  const total = opts.expectedSize !== undefined && opts.expectedSize > 0 ? opts.expectedSize : undefined;
  if (opts.signal?.aborted) throw new AvdmError('DOWNLOAD_FAILED', `下载已取消: ${url}`);

  let existing = await fileSize(part);
  if (total !== undefined && existing > total) {
    // Stale/corrupt partial larger than the archive: start over.
    await fsp.rm(part, { force: true });
    existing = 0;
  }

  let lastReported = -1;
  const report = (n: number) => {
    if (n === lastReported) return;
    lastReported = n;
    try {
      opts.onProgress?.(n, total);
    } catch {
      // progress callbacks must not break the download
    }
  };
  report(existing);

  if (total === undefined || existing !== total) {
    const env = await curlEnv();
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void fileSize(part)
        .then(report)
        .finally(() => {
          polling = false;
        });
    }, 300);
    try {
      for (let attempt = 0; ; attempt++) {
        const args = [
          ...COMMON_ARGS,
          '--speed-limit',
          '1024',
          '--speed-time',
          '60',
          '--continue-at',
          '-',
          '--output',
          part,
          url,
        ];
        const runOpts: Parameters<typeof runCurl>[1] = { env, captureStdout: false, url };
        if (opts.signal) runOpts.signal = opts.signal;
        const r = await runCurl(args, runOpts);
        if (r.code === 0) break;
        // Resume rejected (server ignores ranges / 416 for a stale partial): retry once from scratch.
        const resumeProblem = r.code === 33 || r.code === 36 || (r.code === 22 && /\b416\b/.test(r.stderr));
        if (attempt === 0 && existing > 0 && resumeProblem) {
          await fsp.rm(part, { force: true });
          existing = 0;
          continue;
        }
        throw new AvdmError('DOWNLOAD_FAILED', describeCurlFailure(url, r), { exitCode: r.code });
      }
    } finally {
      clearInterval(timer);
    }
  }

  const size = await fileSize(part);
  if (total !== undefined && size !== total) {
    if (size > total) await fsp.rm(part, { force: true });
    throw new AvdmError('DOWNLOAD_FAILED', `下载失败: ${url}（文件大小不符：收到 ${size} 字节，应为 ${total} 字节）`);
  }
  if (!(await fsp.stat(part).catch(() => undefined))) {
    // curl succeeded without creating a file (empty body): materialise an empty file.
    await fsp.writeFile(part, '');
  }
  await fsp.rename(part, destFile);
  report(size);
}
