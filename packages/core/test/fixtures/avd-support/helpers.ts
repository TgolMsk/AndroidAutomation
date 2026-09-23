/**
 * Shared helpers for the core-avd tests (registry, avd files, clone).
 * Everything lives under os.tmpdir(); nothing touches ~/.avdm or a real SDK.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SPEC, avdNameFor } from '../../../src/constants.js';
import type { InstalledImage, InstanceRecord, InstanceSpec, SdkInfo } from '../../../src/types.js';

export const DEFAULT_IMAGE_PATH = 'system-images;android-35;default;arm64-v8a';

export async function makeTempDir(prefix = 'avdm-avd-'): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function makeSpec(overrides: Partial<InstanceSpec> = {}): InstanceSpec {
  return { ...DEFAULT_SPEC, extraArgs: [], ...overrides };
}

export function makeRecord(index: number, overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    index,
    name: `实例-${index}`,
    avdName: avdNameFor(index),
    image: DEFAULT_IMAGE_PATH,
    spec: makeSpec(),
    createdAt: '2026-01-01T00:00:00.000Z',
    autoRestart: false,
    ...overrides,
  };
}

export function makeImage(sdkRoot: string, overrides: Partial<InstalledImage> = {}): InstalledImage {
  return {
    packagePath: DEFAULT_IMAGE_PATH,
    dir: path.join(sdkRoot, 'system-images', 'android-35', 'default', 'arm64-v8a'),
    sysdirRel: 'system-images/android-35/default/arm64-v8a/',
    platform: 'android-35',
    apiLevel: '35',
    tagId: 'default',
    tagDisplay: 'Default Android System Image',
    abi: 'arm64-v8a',
    revision: '2',
    ...overrides,
  };
}

export function makeSdk(
  root: string,
  opts: { images?: InstalledImage[]; qemuImg?: string } = {},
): SdkInfo {
  return {
    root,
    exists: true,
    emulator: {
      dir: path.join(root, 'emulator'),
      bin: path.join(root, 'emulator', 'emulator'),
      version: '36.6.11',
      qemuImg: opts.qemuImg,
    },
    adb: { bin: path.join(root, 'platform-tools', 'adb') },
    images: opts.images ?? [makeImage(root)],
    acceptedLicenses: ['android-sdk-license'],
  };
}

/**
 * Minimal qcow2 (v3) header carrying an optional backing file name — enough for
 * readers that only look at magic / backing_file_offset / backing_file_size.
 */
export async function writeQcow2(file: string, backing?: string): Promise<void> {
  const header = Buffer.alloc(112);
  header.writeUInt32BE(0x514649fb, 0); // magic "QFI\xfb"
  header.writeUInt32BE(3, 4); // version
  const name = backing ? Buffer.from(backing, 'utf8') : Buffer.alloc(0);
  if (backing) {
    header.writeBigUInt64BE(BigInt(header.length), 8); // backing_file_offset
    header.writeUInt32BE(name.length, 16); // backing_file_size
  }
  header.writeUInt32BE(16, 20); // cluster_bits
  header.writeUInt32BE(104, 100); // header_length
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.concat([header, name]));
}

export interface FakeQemuImg {
  bin: string;
  /** Directory of canned `info` answers: <basename>.json */
  infoDir: string;
  /** Register the canned `qemu-img info --output=json` answer for files with this basename. */
  setInfo(basename: string, info: Record<string, unknown>): Promise<void>;
  /** Make every `rebase` invocation fail with exit code 1. */
  failRebase(): Promise<void>;
  /** argv of every invocation, in order. */
  calls(): Promise<string[][]>;
}

/**
 * A fake `qemu-img` (node script): `info` prints canned JSON keyed by the target's basename
 * (exit 1 when none is registered), `rebase` succeeds (or fails after failRebase()).
 * Every invocation is appended to calls.jsonl.
 */
export async function makeFakeQemuImg(dir: string): Promise<FakeQemuImg> {
  const infoDir = path.join(dir, 'info');
  const log = path.join(dir, 'calls.jsonl');
  const failFlag = path.join(dir, 'fail-rebase');
  const bin = path.join(dir, 'qemu-img');
  await fsp.mkdir(infoDir, { recursive: true });
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'info') {
  const file = args[args.length - 1];
  const canned = path.join(${JSON.stringify(infoDir)}, path.basename(file) + '.json');
  if (fs.existsSync(canned)) {
    process.stdout.write(fs.readFileSync(canned, 'utf8'));
    process.exit(0);
  }
  process.stderr.write("qemu-img: Could not open '" + file + "': No such file or directory\\n");
  process.exit(1);
}
if (args[0] === 'rebase') {
  if (fs.existsSync(${JSON.stringify(failFlag)})) {
    process.stderr.write('qemu-img: rebase failed (fake)\\n');
    process.exit(1);
  }
  process.exit(0);
}
process.stderr.write('fake qemu-img: unsupported command ' + args[0] + '\\n');
process.exit(2);
`;
  await fsp.writeFile(bin, script, { mode: 0o755 });
  return {
    bin,
    infoDir,
    async setInfo(basename, info) {
      await fsp.writeFile(path.join(infoDir, `${basename}.json`), JSON.stringify(info, null, 2));
    },
    async failRebase() {
      await fsp.writeFile(failFlag, '1');
    },
    async calls() {
      const text = await fsp.readFile(log, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
    },
  };
}

/** Relative path → content hash / 'dir' / 'link:<target>' for every entry below `dir` (sorted). */
export async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(e.parentPath, e.name);
    const rel = path.relative(dir, abs);
    if (e.isSymbolicLink()) out[rel] = `link:${await fsp.readlink(abs)}`;
    else if (e.isDirectory()) out[rel] = 'dir';
    else out[rel] = createHash('sha1').update(await fsp.readFile(abs)).digest('hex');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Lists leftover lock dirs / temp files anywhere under `dir` (should be empty after operations settle). */
export async function leftovers(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .filter((p) => p.endsWith('.lock') || p.endsWith('.tmp'));
}
