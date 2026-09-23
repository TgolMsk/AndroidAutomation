import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Namespace imports (not default): both packages are CJS with __esModule=true, so bundlers (electron-vite
// main build) would resolve a default import to `undefined`. Node's ESM loader exposes their named exports.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { AvdmError } from './errors.js';
import type { KeyEventType, ScreenFrame, TouchPoint } from './types.js';

/**
 * gRPC client for the emulator's EmulatorController service (android.emulation.control),
 * using the vendored proto at packages/core/proto/emulator_controller.proto (loaded with
 * @grpc/proto-loader; resolve the proto path relative to this module: ../proto from dist/ or src/).
 * If a bearer token is known (discovery file grpc.token) send `authorization: Bearer <token>` metadata.
 * IMPLEMENTER: agent "core-emu" (see docs/DESIGN.md §grpc).
 */

export interface GrpcStatus {
  version: string;
  uptimeMs: number;
  booted: boolean;
  raw: unknown;
}

export interface ScreenshotOptions {
  /**
   * Target box. The real emulator (verified 37.1.11) scales ONLY when both width and height are set, and then
   * fits the frame inside the box keeping its aspect ratio; with just one of them it returns the full-size
   * frame. To get a frame W pixels wide, pass { width: W, height: round(W * panelHeight / panelWidth) }
   * (see fitScreenshotBox). 0/undefined for both = native size.
   */
  width?: number;
  height?: number;
  format?: 'png' | 'rgba8888' | 'rgb888';
  display?: number;
}

/**
 * Complete a one-sided screenshot size into the box the emulator needs (it ignores width without height and
 * vice versa). `panel` is the device's native display size (frames are always panel-native). Returns {} when
 * no size was requested.
 */
export function fitScreenshotBox(
  req: { width?: number; height?: number },
  panel: { width: number; height: number },
): { width?: number; height?: number } {
  const w = req.width && req.width > 0 ? Math.round(req.width) : 0;
  const h = req.height && req.height > 0 ? Math.round(req.height) : 0;
  const pw = panel.width > 0 ? panel.width : 0;
  const ph = panel.height > 0 ? panel.height : 0;
  // Round the derived side up so the requested side is the binding one of the "fit inside" scale.
  if (w && h) return { width: w, height: h };
  if (w) return { width: w, height: pw && ph ? Math.max(1, Math.ceil((w * ph) / pw)) : w };
  if (h) return { width: pw && ph ? Math.max(1, Math.ceil((h * pw) / ph)) : h, height: h };
  return {};
}

export interface FrameSubscription {
  cancel(): void;
}

export type VmState = 'RUNNING' | 'PAUSED' | 'SHUTDOWN' | 'RESET' | 'RESTART' | 'STOP' | 'START' | 'SAVE_VM' | 'RESTORE_VM';

const VM_STATES: ReadonlySet<string> = new Set<VmState>([
  'RUNNING', 'PAUSED', 'SHUTDOWN', 'RESET', 'RESTART', 'STOP', 'START', 'SAVE_VM', 'RESTORE_VM',
]);

const PROTO_FILE = 'emulator_controller.proto';
const SERVICE_PATH = ['android', 'emulation', 'control', 'EmulatorController'];
const DEFAULT_DEADLINE_MS = 5000;
/** Full-size RGBA frames exceed grpc-js' 4 MiB default. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

let protoPathOverride: string | undefined;
let loadedClient: grpc.ServiceClientConstructor | undefined;

/**
 * Override where the proto is loaded from (the desktop app bundles core into its main process, so
 * import.meta.url-relative lookup does not work there). Resolution order when not overridden:
 *   $AVDM_PROTO_PATH → ../proto/emulator_controller.proto (relative to this module, works from src/ and dist/)
 *   → ./emulator_controller.proto (next to a bundle) → first existing candidate, else throw UNSUPPORTED.
 */
export function setEmulatorProtoPath(protoPath: string): void {
  protoPathOverride = protoPath;
  loadedClient = undefined; // reload from the new location on next use
}

function moduleDir(): string | undefined {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

/** Candidate proto locations, in resolution order. */
export function emulatorProtoCandidates(): string[] {
  if (protoPathOverride) return [protoPathOverride];
  const out: string[] = [];
  if (process.env.AVDM_PROTO_PATH) out.push(process.env.AVDM_PROTO_PATH);
  const dir = moduleDir();
  if (dir) {
    out.push(path.resolve(dir, '..', 'proto', PROTO_FILE));
    out.push(path.resolve(dir, PROTO_FILE));
  }
  return out;
}

/** The proto file that will be loaded (throws AvdmError('UNSUPPORTED') if none exists). */
export function resolveEmulatorProtoPath(): string {
  const candidates = emulatorProtoCandidates();
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new AvdmError('UNSUPPORTED', `找不到模拟器 gRPC 协议文件 ${PROTO_FILE}（已查找: ${candidates.join(', ') || '无'}）`);
  }
  return found;
}

function clientConstructor(): grpc.ServiceClientConstructor {
  if (loadedClient) return loadedClient;
  const protoPath = resolveEmulatorProtoPath();
  let ctor: unknown;
  try {
    const definition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    ctor = SERVICE_PATH.reduce<unknown>(
      (obj, key) => (obj as Record<string, unknown> | undefined)?.[key],
      grpc.loadPackageDefinition(definition),
    );
  } catch (err) {
    throw new AvdmError('UNSUPPORTED', `加载模拟器 gRPC 协议失败 (${protoPath}): ${(err as Error).message}`);
  }
  if (typeof ctor !== 'function') {
    throw new AvdmError('UNSUPPORTED', `协议文件中没有 EmulatorController 服务: ${protoPath}`);
  }
  loadedClient = ctor as grpc.ServiceClientConstructor;
  return loadedClient;
}

// ── message mapping ──

type FrameFormat = ScreenFrame['format'];

const FORMAT_TO_PROTO: Record<FrameFormat, string> = { png: 'PNG', rgba8888: 'RGBA8888', rgb888: 'RGB888' };

function formatFromProto(value: unknown): FrameFormat {
  switch (value) {
    case 'RGBA8888':
    case 1:
      return 'rgba8888';
    case 'RGB888':
    case 2:
      return 'rgb888';
    default:
      return 'png';
  }
}

interface ProtoImageFormat {
  format?: unknown;
  width?: number;
  height?: number;
}

interface ProtoImage {
  format?: ProtoImageFormat | null;
  width?: number;
  height?: number;
  image?: Uint8Array | null;
  seq?: number;
  timestampUs?: number | string;
}

function toUint(value: number | undefined, name: string): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) throw new AvdmError('INVALID_ARGUMENT', `无效的${name}: ${value}`);
  return Math.round(value);
}

function imageFormatRequest(opts: ScreenshotOptions): Record<string, unknown> {
  return {
    format: FORMAT_TO_PROTO[opts.format ?? 'png'] ?? 'PNG',
    width: toUint(opts.width, '截图宽度'),
    height: toUint(opts.height, '截图高度'),
    display: toUint(opts.display, '显示屏编号'),
  };
}

/** Map an `Image` message to a ScreenFrame (size from `format` (new) or the deprecated top-level fields). */
export function imageToFrame(img: ProtoImage): ScreenFrame {
  const fmt = img.format ?? {};
  const data = img.image ? Buffer.from(img.image.buffer, img.image.byteOffset, img.image.byteLength) : Buffer.alloc(0);
  const frame: ScreenFrame = {
    data,
    format: formatFromProto(fmt.format),
    width: Number(fmt.width || img.width || 0),
    height: Number(fmt.height || img.height || 0),
  };
  if (img.seq !== undefined) frame.seq = Number(img.seq);
  if (img.timestampUs !== undefined) frame.timestampUs = Number(img.timestampUs);
  return frame;
}

function grpcError(method: string, err: grpc.ServiceError | Error): AvdmError {
  const se = err as Partial<grpc.ServiceError>;
  const code = typeof se.code === 'number' ? se.code : undefined;
  const codeName = code !== undefined ? grpc.status[code] : undefined;
  let hint = '';
  if (code === grpc.status.UNAVAILABLE) hint = '（模拟器未运行或 gRPC 端口不可达）';
  else if (code === grpc.status.UNAUTHENTICATED || code === grpc.status.PERMISSION_DENIED) hint = '（gRPC 令牌无效或缺失）';
  else if (code === grpc.status.DEADLINE_EXCEEDED) hint = '（调用超时）';
  return new AvdmError('COMMAND_FAILED', `gRPC ${method} 失败${hint}: ${se.details || err.message}`, {
    grpcCode: code,
    grpcStatus: codeName,
  });
}

type UnaryFn = (
  req: unknown,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  cb: (err: grpc.ServiceError | null, res: unknown) => void,
) => grpc.ClientUnaryCall;
type StreamFn = (req: unknown, metadata: grpc.Metadata, options?: grpc.CallOptions) => grpc.ClientReadableStream<unknown>;

export class EmulatorGrpc {
  private client: grpc.Client | undefined;
  private closed = false;

  /** Prefer EmulatorGrpc.create(); the connection is created lazily on first call. */
  constructor(
    readonly port: number,
    private readonly token?: string,
  ) {}

  /** Create a client for localhost:<port>. Does not connect eagerly. */
  static create(port: number, token?: string): EmulatorGrpc {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new AvdmError('INVALID_ARGUMENT', `无效的 gRPC 端口: ${port}`);
    }
    return new EmulatorGrpc(port, token || undefined);
  }

  private getClient(): grpc.Client {
    if (this.closed) throw new AvdmError('INVALID_ARGUMENT', 'gRPC 客户端已关闭');
    if (!this.client) {
      const Ctor = clientConstructor();
      this.client = new Ctor(`localhost:${this.port}`, grpc.credentials.createInsecure(), {
        'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
        'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
      });
    }
    return this.client;
  }

  private metadata(): grpc.Metadata {
    const md = new grpc.Metadata();
    if (this.token) md.set('authorization', `Bearer ${this.token}`);
    return md;
  }

  private method<T>(name: string): T {
    const client = this.getClient() as unknown as Record<string, unknown>;
    const fn = client[name];
    if (typeof fn !== 'function') throw new AvdmError('UNSUPPORTED', `gRPC 方法不存在: ${name}`);
    return (fn as (...args: unknown[]) => unknown).bind(client) as T;
  }

  private unary<Res>(name: string, req: unknown, timeoutMs = DEFAULT_DEADLINE_MS): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      let fn: UnaryFn;
      try {
        fn = this.method<UnaryFn>(name);
      } catch (err) {
        reject(err);
        return;
      }
      fn(req, this.metadata(), { deadline: Date.now() + timeoutMs }, (err, res) => {
        if (err) reject(grpcError(name, err));
        else resolve(res as Res);
      });
    });
  }

  async getStatus(opts: { timeoutMs?: number } = {}): Promise<GrpcStatus> {
    const res = await this.unary<{ version?: string; uptime?: number | string; booted?: boolean }>(
      'getStatus',
      {},
      opts.timeoutMs,
    );
    return {
      version: res?.version ?? '',
      uptimeMs: Number(res?.uptime ?? 0),
      booted: Boolean(res?.booted),
      raw: res,
    };
  }

  async getScreenshot(opts: ScreenshotOptions = {}, timeoutMs = 5000): Promise<ScreenFrame> {
    const req = imageFormatRequest(opts);
    const img = await this.unary<ProtoImage>('getScreenshot', req, timeoutMs);
    return imageToFrame(img ?? {});
  }

  /** Server-streaming screenshots; onFrame for each image, onEnd when the stream ends/errors. */
  streamScreenshot(
    opts: ScreenshotOptions,
    onFrame: (frame: ScreenFrame) => void,
    onEnd?: (err?: Error) => void,
  ): FrameSubscription {
    let ended = false;
    let cancelled = false;
    const end = (err?: Error) => {
      if (ended) return;
      ended = true;
      onEnd?.(err);
    };
    let call: grpc.ClientReadableStream<unknown>;
    try {
      call = this.method<StreamFn>('streamScreenshot')(imageFormatRequest(opts), this.metadata());
    } catch (err) {
      queueMicrotask(() => end(err as Error));
      return { cancel: () => end() };
    }
    call.on('data', (img: ProtoImage) => {
      if (cancelled || ended) return;
      try {
        onFrame(imageToFrame(img));
      } catch {
        // a throwing consumer must not kill the stream
      }
    });
    call.on('error', (err: grpc.ServiceError) => {
      if (cancelled || err.code === grpc.status.CANCELLED) end();
      else end(grpcError('streamScreenshot', err));
    });
    call.on('end', () => end());
    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        call.cancel();
        end();
      },
    };
  }

  /** Coordinates are in device display pixels. pressure 0 = release. */
  async sendTouch(touches: TouchPoint[], display = 0): Promise<void> {
    const list = touches.map((t) => {
      if (![t.x, t.y, t.id, t.pressure].every(Number.isFinite)) {
        throw new AvdmError('INVALID_ARGUMENT', `无效的触摸点: ${JSON.stringify(t)}`);
      }
      return {
        x: Math.round(t.x),
        y: Math.round(t.y),
        identifier: Math.max(0, Math.round(t.id)),
        pressure: Math.max(0, Math.round(t.pressure)),
      };
    });
    await this.unary('sendTouch', { touches: list, display }, 3000);
  }

  /** buttons bitmask: 0 none, 1 left, 2 right. */
  async sendMouse(x: number, y: number, buttons: number, display = 0): Promise<void> {
    if (![x, y, buttons].every(Number.isFinite)) throw new AvdmError('INVALID_ARGUMENT', '无效的鼠标事件参数');
    await this.unary('sendMouse', { x: Math.round(x), y: Math.round(y), buttons: Math.round(buttons), display }, 3000);
  }

  /**
   * Send a key using W3C key names (e.g. "GoBack", "GoHome", "AppSwitch", "Enter", "Backspace", "a")
   * or text (typed as a sequence). eventType default 'keypress'.
   */
  async sendKey(input: { key?: string; text?: string; eventType?: KeyEventType }): Promise<void> {
    if (!input.key && !input.text) throw new AvdmError('INVALID_ARGUMENT', 'sendKey 需要 key 或 text');
    const eventType = input.eventType ?? 'keypress';
    if (!['keydown', 'keyup', 'keypress'].includes(eventType)) {
      throw new AvdmError('INVALID_ARGUMENT', `无效的按键事件类型: ${eventType}`);
    }
    const req = input.text ? { eventType, text: input.text } : { eventType, key: input.key };
    await this.unary('sendKey', req, 3000);
  }

  async setVmState(state: VmState): Promise<void> {
    if (!VM_STATES.has(state)) throw new AvdmError('INVALID_ARGUMENT', `无效的虚拟机状态: ${state}`);
    await this.unary('setVmState', { state });
  }

  async getVmState(): Promise<VmState | 'UNKNOWN'> {
    const res = await this.unary<{ state?: unknown }>('getVmState', {});
    const state = typeof res?.state === 'string' ? res.state : '';
    return VM_STATES.has(state) ? (state as VmState) : 'UNKNOWN';
  }

  close(): void {
    this.closed = true;
    this.client?.close();
    this.client = undefined;
  }
}
