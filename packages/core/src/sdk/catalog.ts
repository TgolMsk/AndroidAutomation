import type { ArchiveInfo, RemotePackage, SdkCatalog } from '../types.js';
import { SDK_REPOSITORY_BASE, SDK_REPOSITORY_XML, SDK_SYSIMG_XMLS } from '../constants.js';
import { AvdmError } from '../errors.js';
import { httpGetText } from './http.js';
import { compareApiLevels, defaultTagDisplay, isFinalPlatformName } from './locate.js';

/**
 * Google SDK repository catalog (repository2-3.xml + sys-img2-4.xml manifests).
 * IMPLEMENTER: agent "core-sdk" (see docs/DESIGN.md §sdk).
 */

export interface HostPlatform {
  os: 'macosx' | 'linux' | 'windows';
  arch: 'aarch64' | 'x64';
}

export function currentHost(): HostPlatform {
  const os: HostPlatform['os'] =
    process.platform === 'darwin' ? 'macosx' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch: HostPlatform['arch'] = process.arch === 'arm64' ? 'aarch64' : 'x64';
  return { os, arch };
}

// ───────────────────────────── Minimal XML parser ─────────────────────────────

/** Element of the tiny DOM produced by parseXml(). Names are local names (namespace prefix stripped). */
export interface XmlNode {
  name: string;
  /** Qualified tag name as written, e.g. "sdk:sdk-repository". */
  qname: string;
  /** Attributes keyed by local name (prefix stripped); xmlns declarations are dropped. */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated character data (entities decoded, CDATA verbatim) directly inside this element. */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode the predefined XML entities plus decimal/hex character references. Unknown entities are kept verbatim. */
export function decodeXmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return String.fromCodePoint(cp);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function localName(qname: string): string {
  const i = qname.indexOf(':');
  return i === -1 ? qname : qname.slice(i + 1);
}

/**
 * Parse an XML document into a lightweight tree. Handles comments, processing instructions, DOCTYPE,
 * CDATA sections, namespace prefixes, quoted '>' inside attribute values and self-closing tags. It is
 * deliberately lenient: mismatched end tags close up to the nearest matching open element.
 * Returns a synthetic "#document" node whose children are the top-level elements.
 */
export function parseXml(xml: string): XmlNode {
  const src = xml.replace(/\r\n?/g, '\n');
  const doc: XmlNode = { name: '#document', qname: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [doc];
  const n = src.length;
  let i = 0;
  const top = () => stack[stack.length - 1] as XmlNode;

  while (i < n) {
    const lt = src.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const cur = top();
      if (cur !== doc) cur.text += decodeXmlEntities(src.slice(i, textEnd));
    }
    if (lt === -1) break;

    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      const cur = top();
      if (cur !== doc) cur.text += src.slice(lt + 9, e === -1 ? n : e);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE (possibly with an internal subset in [...]).
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const ch = src[j];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt + 2);
      const qname = src.slice(lt + 2, e === -1 ? n : e).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if ((stack[k] as XmlNode).qname === qname) {
          stack.length = k;
          break;
        }
      }
      i = e === -1 ? n : e + 1;
      continue;
    }

    // Start tag: find the closing '>' while honouring quoted attribute values.
    let j = lt + 1;
    let quote = '';
    for (; j < n; j++) {
      const ch = src[j];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
    }
    let inner = src.slice(lt + 1, j);
    i = j + 1;
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const nameMatch = /^[^\s/>]+/.exec(inner);
    if (!nameMatch) continue; // stray '<' — ignore
    const qname = nameMatch[0];
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const rest = inner.slice(qname.length);
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(rest)) !== null) {
      const an = m[1] as string;
      if (an === 'xmlns' || an.startsWith('xmlns:')) continue;
      const ln = localName(an);
      if (!(ln in attrs)) attrs[ln] = decodeXmlEntities(m[2] ?? m[3] ?? '');
    }
    const node: XmlNode = { name: localName(qname), qname, attrs, children: [], text: '' };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return doc;
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

function childText(node: XmlNode | undefined, name: string): string | undefined {
  const c = child(node, name);
  if (!c) return undefined;
  return c.text.trim();
}

/** Depth-first (document order) collection of every descendant element named `name`, at any depth. */
function collect(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    collect(c, name, out);
  }
  return out;
}

// ───────────────────────────── Revisions ─────────────────────────────

interface ParsedRevision {
  parts: [number, number, number];
  /** undefined for a final (non-preview) revision. */
  preview?: number;
}

function parseRevision(rev: string): ParsedRevision {
  const nums = rev
    .trim()
    .split(/[.\s-]+|rc/i)
    .filter((x) => x !== '')
    .map((x) => Number.parseInt(x, 10));
  const at = (k: number) => (Number.isFinite(nums[k]) ? (nums[k] as number) : 0);
  const parsed: ParsedRevision = { parts: [at(0), at(1), at(2)] };
  if (nums.length > 3 && Number.isFinite(nums[3])) parsed.preview = nums[3] as number;
  return parsed;
}

/**
 * Compare SDK revisions "major[.minor[.micro[.preview]]]". A final revision sorts after any preview of
 * the same major.minor.micro (37.1.0.3 < 37.1.0). Returns -1, 0, 1.
 */
export function compareRevisions(a: string, b: string): number {
  const pa = parseRevision(a);
  const pb = parseRevision(b);
  for (let k = 0; k < 3; k++) {
    const d = pa.parts[k]! - pb.parts[k]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.preview === pb.preview) return 0;
  if (pa.preview === undefined) return 1;
  if (pb.preview === undefined) return -1;
  return pa.preview < pb.preview ? -1 : 1;
}

function revisionString(node: XmlNode | undefined): string {
  if (!node) return '0';
  const major = childText(node, 'major') || '0';
  const minor = childText(node, 'minor');
  const micro = childText(node, 'micro');
  const preview = childText(node, 'preview');
  if (preview) return [major, minor || '0', micro || '0', preview].join('.');
  if (micro) return [major, minor || '0', micro].join('.');
  if (minor) return [major, minor].join('.');
  return major;
}

// ───────────────────────────── Manifest parsing ─────────────────────────────

function normalizeBaseUrl(baseUrl: string): string {
  if (!baseUrl) return baseUrl;
  if (baseUrl.endsWith('/') || /\.xml(?:[?#].*)?$/i.test(baseUrl)) return baseUrl;
  return baseUrl + '/';
}

function resolveUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

/**
 * sys-img manifests encode API-extension images as `<api-level>35x</api-level>` + `<extension-level>15`
 * + `<base-extension>false`, which we normalise to "35-ext15" (matching the package path "android-35-ext15").
 */
function normalizeApiLevel(raw: string, extensionLevel?: string, baseExtension?: string): string {
  let api = raw.trim();
  const x = /^(\d+(?:\.\d+)?)x$/i.exec(api);
  if (x) api = x[1] as string;
  if (baseExtension === 'false' && extensionLevel && /^\d+$/.test(extensionLevel) && /^\d+(?:\.\d+)?$/.test(api)) {
    return `${api}-ext${extensionLevel}`;
  }
  return api;
}

function parseArchive(node: XmlNode, baseUrl: string): ArchiveInfo | undefined {
  const complete = child(node, 'complete');
  if (!complete) return undefined;
  const url = childText(complete, 'url');
  if (!url) return undefined;
  const checksum = childrenNamed(complete, 'checksum').find((c) => {
    const t = (c.attrs.type ?? 'sha1').toLowerCase();
    return t === 'sha1' || t === 'sha-1';
  });
  const sha1 = checksum?.text.trim().toLowerCase();
  if (!sha1 || !/^[0-9a-f]{40}$/.test(sha1)) return undefined;
  const size = Number.parseInt(childText(complete, 'size') ?? '', 10);
  const archive: ArchiveInfo = {
    url: resolveUrl(url, baseUrl),
    size: Number.isFinite(size) ? size : 0,
    sha1,
  };
  const hostOs = childText(node, 'host-os');
  const hostArch = childText(node, 'host-arch');
  if (hostOs) archive.hostOs = hostOs;
  if (hostArch) archive.hostArch = hostArch;
  return archive;
}

function parseRemotePackage(node: XmlNode, baseUrl: string): RemotePackage | undefined {
  const path = node.attrs.path?.trim();
  if (!path) return undefined;
  const pkg: RemotePackage = {
    path,
    displayName: childText(node, 'display-name') ?? path,
    revision: revisionString(child(node, 'revision')),
    channel: child(node, 'channelRef')?.attrs.ref?.trim() || 'channel-0',
    licenseId: child(node, 'uses-license')?.attrs.ref?.trim() ?? '',
    archives: [],
  };
  for (const a of childrenNamed(child(node, 'archives'), 'archive')) {
    const info = parseArchive(a, baseUrl);
    if (info) pkg.archives.push(info);
  }

  const details = child(node, 'type-details');
  if (details) {
    const apiRaw = childText(details, 'api-level');
    if (apiRaw) {
      pkg.apiLevel = normalizeApiLevel(apiRaw, childText(details, 'extension-level'), childText(details, 'base-extension'));
    }
    const tags = childrenNamed(details, 'tag')
      .map((t) => ({ id: childText(t, 'id') ?? '', display: childText(t, 'display') ?? '' }))
      .filter((t) => t.id);
    if (tags.length) {
      // Multi-tag images (e.g. "google_apis_ps16k" = google_apis + page_size_16kb): the primary tag is the one
      // named by the package path, else the longest one the path segment starts with
      // ("google_apis_playstore_ps16k" → google_apis_playstore, never google_apis), else the first listed.
      const pathTag = path.startsWith('system-images;') ? path.split(';')[2] ?? '' : '';
      const prefixed = tags
        .filter((t) => pathTag.startsWith(`${t.id}_`))
        .sort((a, b) => b.id.length - a.id.length)[0];
      const primary =
        tags.find((t) => t.id === pathTag) ?? prefixed ?? (tags[0] as { id: string; display: string });
      pkg.tagId = primary.id;
      const ordered = [primary, ...tags.filter((t) => t !== primary)];
      pkg.tagDisplay = ordered.map((t) => t.display || defaultTagDisplay(t.id)).join(', ');
    }
    const abi = childText(details, 'abi') || childText(details, 'abis')?.split(/[\s,]+/)[0];
    if (abi) pkg.abi = abi;
  }
  return pkg;
}

/**
 * Parse one repository manifest (repository2-x.xml or sys-img2-x.xml).
 * Relative archive URLs are resolved against `baseUrl` (the manifest's directory URL).
 * Must handle XML namespaces / prefixes (e.g. <sdk:sdk-repository>, <remotePackage>, <archive>,
 * <complete><size/><checksum type="sha1"/><url/></complete>, <host-os>, <host-arch>,
 * <type-details><api-level/><tag><id/><display/></tag><abi/></type-details>, <license id=…>, <uses-license ref=…>,
 * <channelRef ref=…>, <revision><major/><minor/><micro/></revision>, <display-name>).
 * No external XML dependency: implement a small, robust tag-level parser.
 *
 * Obsolete packages (`obsolete="true"`) are skipped, like sdkmanager does by default.
 */
export function parseRepositoryXml(
  xml: string,
  baseUrl: string,
): { packages: RemotePackage[]; licenses: Record<string, string> } {
  const doc = parseXml(xml);
  const base = normalizeBaseUrl(baseUrl);
  const licenses: Record<string, string> = {};
  for (const lic of collect(doc, 'license')) {
    const id = lic.attrs.id?.trim();
    if (id && !(id in licenses)) licenses[id] = lic.text;
  }
  const packages: RemotePackage[] = [];
  for (const node of collect(doc, 'remotePackage')) {
    if ((node.attrs.obsolete ?? '').trim().toLowerCase() === 'true') continue;
    const pkg = parseRemotePackage(node, base);
    if (pkg) packages.push(pkg);
  }
  return { packages, licenses };
}

// ───────────────────────────── Fetching ─────────────────────────────

/**
 * Repository base URL. `AVDM_SDK_REPOSITORY` may point at a mirror of
 * https://dl.google.com/android/repository/ (same layout), or a file:// directory for offline tests.
 */
export function repositoryBaseUrl(): string {
  const env = process.env.AVDM_SDK_REPOSITORY?.trim();
  return normalizeBaseUrl(env || SDK_REPOSITORY_BASE);
}

/**
 * Download repository2-3.xml and the system image manifests for `tags`
 * (default: ['default', 'google_apis', 'google_apis_playstore']) and merge them.
 * Uses httpGetText() (curl-based, proxy aware).
 */
export async function fetchCatalog(opts: { tags?: string[]; signal?: AbortSignal } = {}): Promise<SdkCatalog> {
  const base = repositoryBaseUrl();
  const tags = opts.tags ?? ['default', 'google_apis', 'google_apis_playstore'];
  const manifests: string[] = [SDK_REPOSITORY_XML];
  for (const tag of tags) {
    if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new AvdmError('INVALID_ARGUMENT', `无效的系统镜像标签: "${tag}"`);
    const rel = SDK_SYSIMG_XMLS[tag] ?? `sys-img/${tag === 'default' ? 'android' : tag}/sys-img2-4.xml`;
    if (!manifests.includes(rel)) manifests.push(rel);
  }

  const results = await Promise.all(
    manifests.map(async (rel) => {
      const url = resolveUrl(rel, base);
      const httpOpts: { signal?: AbortSignal } = {};
      if (opts.signal) httpOpts.signal = opts.signal;
      const xml = await httpGetText(url, httpOpts);
      if (!/<(?:[\w-]+:)?(?:sdk-repository|sdk-sys-img|sdk-addon)\b/.test(xml)) {
        throw new AvdmError('DOWNLOAD_FAILED', `SDK 清单格式无法识别: ${url}`);
      }
      return parseRepositoryXml(xml, url);
    }),
  );

  const packages: RemotePackage[] = [];
  const licenses: Record<string, string> = {};
  for (const r of results) {
    packages.push(...r.packages);
    for (const [id, text] of Object.entries(r.licenses)) if (!(id in licenses)) licenses[id] = text;
  }
  return { packages, licenses, fetchedAt: new Date().toISOString() };
}

// ───────────────────────────── Queries ─────────────────────────────

/** Pick the archive matching the host (archives without host-os are host independent). */
export function selectArchive(pkg: RemotePackage, host: HostPlatform = currentHost()): ArchiveInfo | undefined {
  let best: ArchiveInfo | undefined;
  let bestScore = -1;
  for (const a of pkg.archives) {
    if (a.hostOs && a.hostOs !== host.os) continue;
    if (a.hostArch && a.hostArch !== host.arch) continue;
    const score = (a.hostOs ? 2 : 0) + (a.hostArch ? 1 : 0);
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}

function isStable(pkg: RemotePackage): boolean {
  return (pkg.channel || 'channel-0') === 'channel-0';
}

/**
 * Find the newest package with this exact path. By default only stable channel-0 packages;
 * `allowPreview` also considers beta/dev/canary. Only packages with an archive for the host qualify.
 */
export function findPackage(
  catalog: SdkCatalog,
  pkgPath: string,
  opts: { allowPreview?: boolean; host?: HostPlatform } = {},
): RemotePackage | undefined {
  const host = opts.host ?? currentHost();
  let best: RemotePackage | undefined;
  for (const pkg of catalog.packages) {
    if (pkg.path !== pkgPath) continue;
    if (!opts.allowPreview && !isStable(pkg)) continue;
    if (!selectArchive(pkg, host)) continue;
    if (!best || compareRevisions(pkg.revision, best.revision) > 0) best = pkg;
  }
  return best;
}

const TAG_ORDER = ['default', 'google_apis', 'google_apis_playstore'];

function tagRank(tag: string): number {
  const i = TAG_ORDER.indexOf(tag);
  return i === -1 ? TAG_ORDER.length : i;
}

/**
 * arm64-v8a system images available for this host, newest API first (stable only unless allowPreview).
 * "Stable" means channel-0 and a released platform name: developer previews such as "android-CANARY",
 * "android-37.2-beta3" or "android-canary-20260909" are published on channel-0 too but are hidden by default.
 * Images without a tag-specific display name get one from the tag id.
 */
export function listSystemImages(catalog: SdkCatalog, opts: { allowPreview?: boolean } = {}): RemotePackage[] {
  const host = currentHost();
  const byPath = new Map<string, RemotePackage>();
  for (const pkg of catalog.packages) {
    if (!pkg.path.startsWith('system-images;')) continue;
    const segs = pkg.path.split(';');
    const abi = pkg.abi ?? segs[3];
    if (abi !== 'arm64-v8a') continue;
    if (!opts.allowPreview && (!isStable(pkg) || !isFinalPlatformName(segs[1] ?? ''))) continue;
    if (!selectArchive(pkg, host)) continue;
    const prev = byPath.get(pkg.path);
    if (!prev || compareRevisions(pkg.revision, prev.revision) > 0) byPath.set(pkg.path, pkg);
  }
  const key = (p: RemotePackage) => {
    const segs = p.path.split(';');
    const platform = segs[1] ?? '';
    return {
      api: p.apiLevel ?? platform.replace(/^android-/, ''),
      final: isFinalPlatformName(platform),
      tag: segs[2] ?? p.tagId ?? '',
    };
  };
  return [...byPath.values()].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const api = compareApiLevels(kb.api, ka.api);
    if (api !== 0) return api;
    if (ka.final !== kb.final) return ka.final ? -1 : 1;
    const t = tagRank(ka.tag) - tagRank(kb.tag);
    if (t !== 0) return t;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}
