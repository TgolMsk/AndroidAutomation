import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  httpDownload,
  httpGetText,
  parseScutilProxy,
  proxyEnvFromEnv,
  proxyEnvFromScutil,
  resolveProxyEnv,
} from '../src/sdk/http.js';
import { isAvdmError } from '../src/errors.js';

const SCUTIL_SAMPLE = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : *.local
    3 : 169.254/16
  }
  ExcludeSimpleHostnames : 0
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 6152
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 6152
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`;

describe('parseScutilProxy', () => {
  it('parses scalar keys and the exceptions array', () => {
    const r = parseScutilProxy(SCUTIL_SAMPLE);
    expect(r.values).toMatchObject({
      HTTPEnable: '1',
      HTTPPort: '6152',
      HTTPProxy: '127.0.0.1',
      HTTPSEnable: '1',
      HTTPSPort: '6152',
      HTTPSProxy: '127.0.0.1',
      SOCKSEnable: '0',
    });
    expect(r.values.ExceptionsList).toBeUndefined();
    expect(r.exceptions).toEqual(['127.0.0.1', 'localhost', '*.local', '169.254/16']);
  });

  it('handles the minimal format from the task description', () => {
    const r = parseScutilProxy(
      '<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 6152\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 6152\n  HTTPSProxy : 127.0.0.1\n}',
    );
    expect(r.values.HTTPSProxy).toBe('127.0.0.1');
    expect(r.exceptions).toEqual([]);
  });

  it('returns empty results for garbage', () => {
    expect(parseScutilProxy('')).toEqual({ values: {}, exceptions: [] });
    expect(parseScutilProxy('not a dictionary')).toEqual({ values: {}, exceptions: [] });
  });
});

describe('proxyEnvFromScutil', () => {
  it('uses the HTTPS proxy when enabled and adds NO_PROXY', () => {
    const env = proxyEnvFromScutil(SCUTIL_SAMPLE)!;
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:6152');
    expect(env.https_proxy).toBe('http://127.0.0.1:6152');
    expect(env.http_proxy).toBe('http://127.0.0.1:6152');
    const noProxy = env.NO_PROXY!.split(',');
    expect(noProxy).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '.local', '169.254/16']));
    expect(new Set(noProxy).size).toBe(noProxy.length);
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('falls back to the HTTP proxy when HTTPS is disabled', () => {
    const env = proxyEnvFromScutil(
      '<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : proxy.lan\n  HTTPSEnable : 0\n  HTTPSPort : 1\n  HTTPSProxy : other\n}',
    )!;
    expect(env.https_proxy).toBe('http://proxy.lan:8080');
    expect(env.http_proxy).toBe('http://proxy.lan:8080');
  });

  it('uses SOCKS only as a last resort and returns undefined when nothing is enabled', () => {
    const socks = proxyEnvFromScutil('<dictionary> {\n  SOCKSEnable : 1\n  SOCKSPort : 1080\n  SOCKSProxy : ::1\n}')!;
    expect(socks.ALL_PROXY).toBe('socks5h://[::1]:1080');
    expect(socks.https_proxy).toBeUndefined();
    expect(proxyEnvFromScutil('<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}')).toBeUndefined();
  });
});

describe('proxyEnvFromEnv', () => {
  it('returns undefined without proxy variables', () => {
    expect(proxyEnvFromEnv({ PATH: '/bin' })).toBeUndefined();
    expect(proxyEnvFromEnv({ HTTPS_PROXY: '  ' })).toBeUndefined();
  });

  it('keeps existing variables, mirrors case and merges NO_PROXY', () => {
    const env = proxyEnvFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'corp.example,localhost' })!;
    expect(env.https_proxy).toBe('http://p:1');
    expect(env.HTTPS_PROXY).toBe('http://p:1');
    expect(env.http_proxy).toBeUndefined();
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,corp.example');
  });

  it('uses an http-only proxy for https as well, and passes ALL_PROXY through', () => {
    const env = proxyEnvFromEnv({ http_proxy: 'http://h:3128', ALL_PROXY: 'socks5://s:1' })!;
    expect(env.https_proxy).toBe('http://h:3128');
    expect(env.http_proxy).toBe('http://h:3128');
    expect(env.all_proxy).toBe('socks5://s:1');
  });
});

describe('resolveProxyEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('prefers proxy variables from the environment', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://10.0.0.1:9999');
    vi.stubEnv('https_proxy', '');
    const env = await resolveProxyEnv();
    expect(env.https_proxy).toBe('http://10.0.0.1:9999');
    expect(env.NO_PROXY).toContain('127.0.0.1');
  });

  it('falls back to the system proxy (or nothing) without throwing', async () => {
    for (const k of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']) vi.stubEnv(k, '');
    const env = await resolveProxyEnv();
    expect(typeof env).toBe('object');
    if (env.https_proxy) expect(env.NO_PROXY).toContain('localhost');
  });
});

// ───────────────────────────── curl-backed transfers ─────────────────────────────

interface ServerState {
  requests: Array<{ url: string; range?: string }>;
  ignoreRange: boolean;
}

const PAYLOAD = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7 + 3) % 251));

describe('httpGetText / httpDownload', () => {
  let server: Server;
  let base: string;
  let tmp: string;
  const state: ServerState = { requests: [], ignoreRange: false };

  function handler(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    const range = req.headers.range;
    state.requests.push(range ? { url, range } : { url });
    if (url === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('你好, manifest <xml/>');
      return;
    }
    if (url === '/missing') {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    if (url === '/slow') {
      res.writeHead(200, { 'content-length': String(10_000_000) });
      const timer = setInterval(() => {
        if (!res.write(Buffer.alloc(1024, 1))) return;
      }, 50);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (url === '/blob') {
      const m = !state.ignoreRange && range ? /^bytes=(\d+)-$/.exec(range) : null;
      if (m) {
        const start = Number(m[1]);
        if (start >= PAYLOAD.length) {
          res.writeHead(416, { 'content-range': `bytes */${PAYLOAD.length}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'content-length': String(PAYLOAD.length - start),
          'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
          'accept-ranges': 'bytes',
        });
        res.end(PAYLOAD.subarray(start));
        return;
      }
      res.writeHead(200, { 'content-length': String(PAYLOAD.length), 'accept-ranges': 'bytes' });
      res.end(PAYLOAD);
      return;
    }
    res.writeHead(500);
    res.end();
  }

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'avdm-sdk-http-'));
    server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    state.requests = [];
    state.ignoreRange = false;
  });

  it('httpGetText fetches over http (bypassing any configured proxy for 127.0.0.1) and file://', async () => {
    expect(await httpGetText(`${base}/text`)).toBe('你好, manifest <xml/>');
    const f = path.join(tmp, 'local.txt');
    writeFileSync(f, 'from disk');
    expect(await httpGetText(pathToFileURL(f).href)).toBe('from disk');
  });

  it('httpGetText rejects with DOWNLOAD_FAILED on HTTP errors and missing files', async () => {
    const e1 = await httpGetText(`${base}/missing`).catch((e: unknown) => e);
    expect(isAvdmError(e1, 'DOWNLOAD_FAILED')).toBe(true);
    expect((e1 as Error).message).toContain('HTTP');
    const e2 = await httpGetText(pathToFileURL(path.join(tmp, 'nope.txt')).href).catch((e: unknown) => e);
    expect(isAvdmError(e2, 'DOWNLOAD_FAILED')).toBe(true);
  });

  it('httpGetText honours an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await httpGetText(`${base}/text`, { signal: ac.signal }).catch((e: unknown) => e);
    expect(isAvdmError(err, 'DOWNLOAD_FAILED')).toBe(true);
  });

  it('downloads a file, reports progress and renames .part', async () => {
    const dest = path.join(tmp, 'full', 'blob.bin');
    const progress: Array<[number, number | undefined]> = [];
    await httpDownload(`${base}/blob`, dest, {
      expectedSize: PAYLOAD.length,
      onProgress: (r, t) => progress.push([r, t]),
    });
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(progress[0]).toEqual([0, PAYLOAD.length]);
    expect(progress.at(-1)).toEqual([PAYLOAD.length, PAYLOAD.length]);
  });

  it('resumes from an existing .part file with a Range request', async () => {
    const dest = path.join(tmp, 'resume.bin');
    writeFileSync(`${dest}.part`, PAYLOAD.subarray(0, 50_000));
    await httpDownload(`${base}/blob`, dest, { expectedSize: PAYLOAD.length });
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
    expect(state.requests).toEqual([{ url: '/blob', range: 'bytes=50000-' }]);
  });

  it('restarts from scratch when the server ignores Range', async () => {
    state.ignoreRange = true;
    const dest = path.join(tmp, 'norange.bin');
    writeFileSync(`${dest}.part`, PAYLOAD.subarray(0, 1000));
    await httpDownload(`${base}/blob`, dest, { expectedSize: PAYLOAD.length });
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
    expect(state.requests.length).toBe(2);
    expect(state.requests[1]!.range).toBeUndefined();
  });

  it('discards a .part larger than expected and skips the transfer for a complete one', async () => {
    const big = path.join(tmp, 'big.bin');
    writeFileSync(`${big}.part`, Buffer.alloc(PAYLOAD.length + 10, 9));
    await httpDownload(`${base}/blob`, big, { expectedSize: PAYLOAD.length });
    expect(readFileSync(big).equals(PAYLOAD)).toBe(true);
    expect(state.requests).toEqual([{ url: '/blob' }]);

    state.requests = [];
    const done = path.join(tmp, 'done.bin');
    writeFileSync(`${done}.part`, PAYLOAD);
    await httpDownload(`${base}/blob`, done, { expectedSize: PAYLOAD.length });
    expect(readFileSync(done).equals(PAYLOAD)).toBe(true);
    expect(state.requests).toEqual([]);
  });

  it('rejects with DOWNLOAD_FAILED on 404 and on a size mismatch', async () => {
    const e1 = await httpDownload(`${base}/missing`, path.join(tmp, 'm.bin')).catch((e: unknown) => e);
    expect(isAvdmError(e1, 'DOWNLOAD_FAILED')).toBe(true);
    expect(existsSync(path.join(tmp, 'm.bin'))).toBe(false);

    const e2 = await httpDownload(`${base}/blob`, path.join(tmp, 'short.bin'), {
      expectedSize: PAYLOAD.length + 1,
    }).catch((e: unknown) => e);
    expect(isAvdmError(e2, 'DOWNLOAD_FAILED')).toBe(true);
    expect((e2 as Error).message).toContain('大小');
    expect(existsSync(path.join(tmp, 'short.bin'))).toBe(false);
  });

  it('downloads file:// URLs', async () => {
    const src = path.join(tmp, 'src.bin');
    writeFileSync(src, PAYLOAD);
    const dest = path.join(tmp, 'copy.bin');
    await httpDownload(pathToFileURL(src).href, dest, { expectedSize: PAYLOAD.length });
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
  });

  it('AbortSignal kills curl, rejects with DOWNLOAD_FAILED and keeps the partial file', async () => {
    const dest = path.join(tmp, 'slow.bin');
    const ac = new AbortController();
    let lastProgress = 0;
    const started = Date.now();
    const p = httpDownload(`${base}/slow`, dest, {
      signal: ac.signal,
      onProgress: (r) => {
        lastProgress = r;
      },
    });
    setTimeout(() => ac.abort(), 1200);
    const err = await p.catch((e: unknown) => e);
    expect(isAvdmError(err, 'DOWNLOAD_FAILED')).toBe(true);
    expect((err as Error).message).toContain('取消');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(dest)).toBe(false);
    expect(statSync(`${dest}.part`).size).toBeGreaterThan(0);
    expect(lastProgress).toBeGreaterThan(0);
  });
});
