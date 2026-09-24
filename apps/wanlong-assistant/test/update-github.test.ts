/**
 * The GitHub Releases port with a fake fetch and a temp Downloads folder: release parsing, SHA256SUMS parsing,
 * download with progress, resume, checksum verification, cancellation and timeouts. No network.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describe as describeError, type UpdateRelease } from '../src/main/update/center';
import {
  GitHubUpdater, RELEASES_API_URL, isReleasePageUrl, normalizeNotes, parseAssetVersion, parseChecksums, pickRelease,
  releasePageUrl, type FetchLike,
} from '../src/main/update/github';

const PAGE = 'https://github.com/TgolMsk/AndroidAutomation/releases';
const DOWNLOAD = `${PAGE}/download`;
const HEX = 'a'.repeat(64);

function assetOf(name: string, size = 1000, tag = 'v0.4.0') {
  return { name, size, state: 'uploaded', browser_download_url: `${DOWNLOAD}/${tag}/${name}` };
}

function releaseJson(version: string, extra: Record<string, unknown> = {}) {
  const tag = `v${version}`;
  return {
    tag_name: tag,
    html_url: `${PAGE}/tag/${tag}`,
    draft: false,
    prerelease: true,
    published_at: '2026-09-20T04:00:00Z',
    body: `## ${version}\r\n\r\n<!-- 内部备注 -->修了几个 bug`,
    assets: [
      assetOf(`AVDM-${version}-mac-arm64.dmg`, 2000, tag),
      assetOf(`Wanlong-Assistant-${version}-mac-arm64.dmg`, 1000, tag),
      assetOf('SHA256SUMS', 200, tag),
    ],
    ...extra,
  };
}

describe('发布信息解析', () => {
  it('从安装包文件名取版本号', () => {
    expect(parseAssetVersion('Wanlong-Assistant-0.4.0-mac-arm64.dmg')).toBe('0.4.0');
    expect(parseAssetVersion('Wanlong-Assistant-0.4.0-beta.2-mac-arm64.dmg')).toBe('0.4.0-beta.2');
    expect(parseAssetVersion('AVDM-0.4.0-mac-arm64.dmg')).toBeNull();
    expect(parseAssetVersion('Wanlong-Assistant-0.4.0-mac-arm64.zip')).toBeNull();
    expect(parseAssetVersion('../Wanlong-Assistant-0.4.0-mac-arm64.dmg')).toBeNull();
  });

  it('挑版本最高、带助手安装包的发布（含预览版），跳过草稿与只有模拟器安装包的发布', () => {
    const picked = pickRelease([
      releaseJson('0.5.0', { draft: true }),
      { ...releaseJson('0.4.1'), assets: [assetOf('AVDM-0.4.1-mac-arm64.dmg', 1, 'v0.4.1')] },
      releaseJson('0.4.0'),
      releaseJson('0.3.0', { prerelease: false }),
    ]);
    expect(picked).toEqual<UpdateRelease>({
      version: '0.4.0',
      releaseNotes: '## 0.4.0\n\n修了几个 bug',
      releaseUrl: `${PAGE}/tag/v0.4.0`,
      prerelease: true,
      publishedAt: Date.parse('2026-09-20T04:00:00Z'),
      asset: { name: 'Wanlong-Assistant-0.4.0-mac-arm64.dmg', size: 1000, url: `${DOWNLOAD}/v0.4.0/Wanlong-Assistant-0.4.0-mac-arm64.dmg` },
      checksumsUrl: `${DOWNLOAD}/v0.4.0/SHA256SUMS`,
    });
  });

  it('不信任仓库之外的地址；没有安装包就返回 null', () => {
    const foreign = releaseJson('0.6.0', {
      html_url: 'https://evil.example/release',
      assets: [{ ...assetOf('Wanlong-Assistant-0.6.0-mac-arm64.dmg'), browser_download_url: 'https://evil.example/x.dmg' }],
    });
    expect(pickRelease([foreign])).toBeNull();
    const page = pickRelease([releaseJson('0.4.0', { html_url: 'https://evil.example/release' })]);
    expect(page?.releaseUrl).toBe(`${PAGE}/tag/v0.4.0`);
    const noSums = pickRelease([{ ...releaseJson('0.4.0'), assets: [assetOf('Wanlong-Assistant-0.4.0-mac-arm64.dmg')] }]);
    expect(noSums?.checksumsUrl).toBeNull();
    expect(pickRelease([])).toBeNull();
    const broken = pickRelease([{ ...releaseJson('0.4.0'), assets: [{ ...assetOf('Wanlong-Assistant-0.4.0-mac-arm64.dmg'), size: 0 }] }]);
    expect(broken).toBeNull();
  });

  it('返回的不是列表时给出中文原因', () => {
    expect(() => pickRelease({ message: 'Not Found' })).toThrow('格式不对');
  });

  it('SHA256SUMS：按文件名（去掉 wanlong-assistant/ 目录）取摘要，兼容二进制标记', () => {
    const sums = parseChecksums([
      `${'B'.repeat(64)}  AVDM-0.4.0-mac-arm64.dmg`,
      `${HEX}  wanlong-assistant/Wanlong-Assistant-0.4.0-mac-arm64.dmg`,
      `${'c'.repeat(64)} *other.dmg`,
      'garbage line',
      '',
    ].join('\n'));
    expect(sums.get('Wanlong-Assistant-0.4.0-mac-arm64.dmg')).toBe(HEX);
    expect(sums.get('AVDM-0.4.0-mac-arm64.dmg')).toBe('b'.repeat(64));
    expect(sums.get('other.dmg')).toBe('c'.repeat(64));
    expect(sums.size).toBe(3);
  });

  it('更新说明：纯文本、去掉 HTML 注释、过长截断', () => {
    expect(normalizeNotes('  ')).toBeNull();
    expect(normalizeNotes(42)).toBeNull();
    expect(normalizeNotes('a\r\nb<!-- x -->')).toBe('a\nb');
    const long = normalizeNotes('字'.repeat(9000));
    expect(long?.length).toBeLessThan(8100);
    expect(long).toContain('Release 页');
  });

  it('只允许打开本仓库的发布页', () => {
    expect(releasePageUrl('v0.4.0')).toBe(`${PAGE}/tag/v0.4.0`);
    expect(releasePageUrl()).toBe(`${PAGE}/latest`);
    expect(isReleasePageUrl(`${PAGE}/tag/v0.4.0`)).toBe(true);
    expect(isReleasePageUrl(PAGE)).toBe(true);
    expect(isReleasePageUrl('https://github.com/TgolMsk/AndroidAutomationX/releases')).toBe(false);
    expect(isReleasePageUrl('https://evil.example/')).toBe(false);
  });
});

// ── download harness ────────────────────────────────────────────────────────────────────────────────────────

const NAME = 'Wanlong-Assistant-0.4.0-mac-arm64.dmg';
const ASSET_URL = `${DOWNLOAD}/v0.4.0/${NAME}`;
const SUMS_URL = `${DOWNLOAD}/v0.4.0/SHA256SUMS`;

function bytes(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x & 0xff; }
  return out;
}

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

interface Server {
  payload: Uint8Array;
  /** Digest advertised in SHA256SUMS (defaults to the payload's). */
  digest?: string;
  honourRange?: boolean;
  /** Stop sending after this many bytes and never close (a stalled connection). */
  stallAfter?: number;
  /** Close the connection early after this many bytes. */
  truncateAfter?: number;
  chunk?: number;
  apiStatus?: number;
  apiHeaders?: Record<string, string>;
  releases?: unknown;
}

function makeFetch(server: Server) {
  const calls: { url: string; range: string | null; ua: string | null }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, range: headers.get('range'), ua: headers.get('user-agent') });
    if (init.signal?.aborted) throw init.signal.reason;
    if (url === RELEASES_API_URL) {
      const status = server.apiStatus ?? 200;
      const body = status === 200 ? JSON.stringify(server.releases ?? [releaseJson('0.4.0')]) : '{"message":"API rate limit exceeded for 1.2.3.4."}';
      return new Response(body, { status, headers: server.apiHeaders ?? {} });
    }
    if (url === SUMS_URL) {
      return new Response(`${server.digest ?? sha(server.payload)}  wanlong-assistant/${NAME}\n${'d'.repeat(64)}  AVDM-0.4.0-mac-arm64.dmg\n`);
    }
    if (url !== ASSET_URL) return new Response('nope', { status: 404 });
    const range = headers.get('range');
    const start = range && server.honourRange !== false ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    if (start >= server.payload.length && range) return new Response('', { status: 416 });
    const slice = server.payload.subarray(start);
    const step = server.chunk ?? 64;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const limit = server.stallAfter ?? server.truncateAfter;
        if (limit !== undefined && start + sent >= limit) {
          if (server.truncateAfter !== undefined) controller.close();
          return new Promise(() => undefined); // stall: never enqueue again
        }
        if (sent >= slice.length) { controller.close(); return; }
        const next = slice.subarray(sent, sent + step);
        sent += next.byteLength;
        controller.enqueue(next);
        return undefined;
      },
    });
    return new Response(body, {
      status: range && server.honourRange !== false ? 206 : 200,
      headers: { 'content-length': String(slice.length) },
    });
  };
  return { fetch, calls };
}

const RELEASE: UpdateRelease = {
  version: '0.4.0', releaseNotes: null, releaseUrl: `${PAGE}/tag/v0.4.0`, prerelease: true, publishedAt: null,
  asset: { name: NAME, size: 1000, url: ASSET_URL }, checksumsUrl: SUMS_URL,
};

describe('GitHubUpdater', () => {
  let dir: string;
  let opened: string[];
  let revealed: string[];
  let openResult: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'avdm-update-'));
    opened = [];
    revealed = [];
    openResult = '';
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function updater(server: Server, extra: { idleTimeoutMs?: number } = {}) {
    const net = makeFetch(server);
    const port = new GitHubUpdater({
      fetch: net.fetch,
      downloadsDir: () => dir,
      userAgent: 'WanlongAssistant/0.3.0',
      openPath: async (file) => { opened.push(file); return openResult; },
      showItemInFolder: (file) => { revealed.push(file); },
      progressIntervalMs: 0,
      ...extra,
    });
    return { port, calls: net.calls };
  }

  const options = (signal = new AbortController().signal) => {
    const progress: number[] = [];
    return { progress, options: { signal, onProgress: (p: { percent: number }) => { progress.push(p.percent); } } };
  };

  it('检查：请求发布列表（带 User-Agent）并挑出安装包', async () => {
    const { port, calls } = updater({ payload: bytes(1000) });
    const found = await port.check();
    expect(found?.version).toBe('0.4.0');
    expect(calls[0]).toMatchObject({ url: RELEASES_API_URL, ua: 'WanlongAssistant/0.3.0' });
  });

  it('限流与 404 变成 describe() 认得的错误', async () => {
    const limited = updater({ payload: bytes(10), apiStatus: 403, apiHeaders: { 'x-ratelimit-remaining': '0' } }).port;
    expect(describeError(await limited.check().catch((e: unknown) => e))).toContain('限流');
    const missing = updater({ payload: bytes(10), apiStatus: 404 }).port;
    expect(describeError(await missing.check().catch((e: unknown) => e))).toContain('没找到发布信息');
  });

  it('下载：带进度写到 .part，校验通过后改名成安装包', async () => {
    const payload = bytes(1000);
    const { port } = updater({ payload });
    const run = options();
    const file = await port.download(RELEASE, run.options);
    expect(file).toBe(path.join(dir, NAME));
    expect(sha(await readFile(file))).toBe(sha(payload));
    expect(await readdir(dir)).toEqual([NAME]);
    expect(run.progress.length).toBeGreaterThan(3);
    expect(run.progress.at(-1)).toBe(100);
    expect([...run.progress].sort((a, b) => a - b)).toEqual(run.progress);
  });

  it('★ 校验不过：删掉临时文件、不留安装包，错误翻成「校验没通过」', async () => {
    const { port } = updater({ payload: bytes(1000), digest: HEX });
    const error = await port.download(RELEASE, options().options).catch((e: unknown) => e);
    expect(describeError(error)).toBe('下载的文件校验没通过，已丢弃，请重试。');
    expect(await readdir(dir)).toEqual([]);
  });

  it('SHA256SUMS 缺失或不含本安装包：拒绝下载', async () => {
    const { port, calls } = updater({ payload: bytes(1000) });
    await expect(port.download({ ...RELEASE, checksumsUrl: null }, options().options)).rejects.toThrow('缺少校验文件');
    await expect(port.download({ ...RELEASE, asset: { ...RELEASE.asset, name: 'Wanlong-Assistant-0.4.1-mac-arm64.dmg' } }, options().options))
      .rejects.toThrow('SHA256SUMS 里没有');
    expect(calls.some((call) => call.url === ASSET_URL)).toBe(false);
  });

  it('不可信的地址或文件名：连校验文件都不取', async () => {
    const { port, calls } = updater({ payload: bytes(1000) });
    await expect(port.download({ ...RELEASE, asset: { ...RELEASE.asset, url: 'https://evil.example/x.dmg' } }, options().options)).rejects.toThrow('不可信');
    await expect(port.download({ ...RELEASE, asset: { ...RELEASE.asset, name: '../../evil.dmg' } }, options().options)).rejects.toThrow('不可信');
    expect(calls).toEqual([]);
  });

  it('★ 断点续传：已有的 .part 用 Range 接着下', async () => {
    const payload = bytes(1000);
    await writeFile(path.join(dir, `${NAME}.part`), payload.subarray(0, 400));
    const { port, calls } = updater({ payload });
    const file = await port.download(RELEASE, options().options);
    expect(sha(await readFile(file))).toBe(sha(payload));
    expect(calls.find((call) => call.url === ASSET_URL)?.range).toBe('bytes=400-');
  });

  it('服务器不认 Range（回 200 全量）：从头写，不拼接出坏文件', async () => {
    const payload = bytes(1000);
    await writeFile(path.join(dir, `${NAME}.part`), bytes(400, 99));
    const { port } = updater({ payload, honourRange: false });
    const file = await port.download(RELEASE, options().options);
    expect(sha(await readFile(file))).toBe(sha(payload));
  });

  it('旧的 .part 内容不对（发布被重传过）：校验失败后丢弃，下一次从头下载成功', async () => {
    const payload = bytes(1000);
    await writeFile(path.join(dir, `${NAME}.part`), bytes(400, 99));
    const { port } = updater({ payload });
    await expect(port.download(RELEASE, options().options)).rejects.toThrow('sha256 mismatch');
    await expect(stat(path.join(dir, `${NAME}.part`))).rejects.toThrow();
    const file = await port.download(RELEASE, options().options);
    expect(sha(await readFile(file))).toBe(sha(payload));
  });

  it('已经下好且校验通过的安装包直接复用，不再下载', async () => {
    const payload = bytes(1000);
    await writeFile(path.join(dir, NAME), payload);
    const { port, calls } = updater({ payload });
    const run = options();
    expect(await port.download(RELEASE, run.options)).toBe(path.join(dir, NAME));
    expect(calls.some((call) => call.url === ASSET_URL)).toBe(false);
    expect(run.progress).toEqual([100]);
  });

  it('同名但内容不对的旧安装包：重新下载后替换', async () => {
    const payload = bytes(1000);
    await writeFile(path.join(dir, NAME), bytes(1000, 3));
    const { port } = updater({ payload });
    const file = await port.download(RELEASE, options().options);
    expect(sha(await readFile(file))).toBe(sha(payload));
  });

  it('连接提前断开：保留 .part 供续传，错误是网络类', async () => {
    const { port } = updater({ payload: bytes(1000), truncateAfter: 512 });
    const error = await port.download(RELEASE, options().options).catch((e: unknown) => e);
    expect(describeError(error)).toContain('连不上 GitHub');
    expect((await stat(path.join(dir, `${NAME}.part`))).size).toBe(512);
  });

  it('长时间没有数据：按空闲超时中止，保留 .part', async () => {
    const { port } = updater({ payload: bytes(1000), stallAfter: 256 }, { idleTimeoutMs: 50 });
    const error = await port.download(RELEASE, options().options).catch((e: unknown) => e);
    expect((error as Error).message).toContain('ETIMEDOUT');
    expect(describeError(error)).toContain('连不上 GitHub');
    expect((await stat(path.join(dir, `${NAME}.part`))).size).toBe(256);
  });

  it('取消：以取消原因结束，保留 .part，之后能续传完成', async () => {
    const payload = bytes(1000);
    const server: Server = { payload, stallAfter: 320 };
    const { port } = updater(server);
    const controller = new AbortController();
    const pending = port.download(RELEASE, options(controller.signal).options);
    await vi.waitFor(async () => expect((await stat(path.join(dir, `${NAME}.part`)).catch(() => ({ size: 0 }))).size).toBe(320));
    controller.abort(new Error('已取消下载'));
    await expect(pending).rejects.toThrow('已取消下载');
    delete server.stallAfter;
    const file = await port.download(RELEASE, options().options);
    expect(sha(await readFile(file))).toBe(sha(payload));
  });

  it('响应比发布信息大：丢弃', async () => {
    const payload = bytes(1200);
    const { port } = updater({ payload, digest: sha(payload) });
    const error = await port.download(RELEASE, options().options).catch((e: unknown) => e);
    expect(describeError(error)).toBe('下载的文件校验没通过，已丢弃，请重试。');
    expect(await readdir(dir)).toEqual([]);
  });

  it('安装前复核：被删 → 中文原因；被改 → 删除并报校验失败；完好 → 通过', async () => {
    const payload = bytes(1000);
    const { port } = updater({ payload });
    const file = await port.download(RELEASE, options().options);
    await expect(port.verify(file, RELEASE)).resolves.toBeUndefined();
    await writeFile(file, bytes(1000, 5));
    await expect(port.verify(file, RELEASE)).rejects.toThrow('sha256 mismatch');
    await expect(stat(file)).rejects.toThrow();
    await expect(port.verify(file, RELEASE)).rejects.toThrow('已被移走或删除');
  });

  it('打开与在访达中显示走注入的外壳接口；打不开给出原因', async () => {
    const { port } = updater({ payload: bytes(10) });
    await port.open('/x/a.dmg');
    await port.reveal('/x/a.dmg');
    expect(opened).toEqual(['/x/a.dmg']);
    expect(revealed).toEqual(['/x/a.dmg']);
    openResult = 'Failed to open';
    await expect(port.open('/x/a.dmg')).rejects.toThrow('无法打开安装包：Failed to open');
  });
});
