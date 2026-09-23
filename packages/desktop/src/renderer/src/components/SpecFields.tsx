import { useEffect, useState } from 'react';
import type { GlDriver, GpuMode, InstanceSpec } from '@avdm/core';
import { formatMb, joinArgs, splitArgs } from '../format';

export const RESOLUTION_PRESETS = [
  { id: '1280x720', label: '1280×720 横屏', width: 1280, height: 720 },
  { id: '1920x1080', label: '1920×1080 横屏', width: 1920, height: 1080 },
  { id: '720x1280', label: '720×1280 竖屏', width: 720, height: 1280 },
  { id: '1080x1920', label: '1080×1920 竖屏', width: 1080, height: 1920 },
] as const;

const CPU_OPTIONS = [1, 2, 3, 4, 6, 8];
const RAM_OPTIONS = [2048, 3072, 4096, 6144, 8192, 12288];
const DPI_OPTIONS = [160, 213, 240, 280, 320, 360, 400, 420, 480, 560];
const GL_OPTIONS: Array<{ value: GlDriver; label: string }> = [
  { value: 'angle', label: 'ANGLE（GLES 3.1 + ASTC，推荐）' },
  { value: 'translator', label: '翻译层（GLES 3.0）' },
];
const GPU_OPTIONS: Array<{ value: GpuMode; label: string }> = [
  { value: 'host', label: '硬件加速（Metal）' },
  { value: 'software', label: '软件渲染' },
  { value: 'auto', label: '自动' },
];

function withCurrent(options: number[], current: number): number[] {
  return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

/** Client-side mirror of core validateSpec() for inline hints (core re-validates). */
export function specProblems(spec: InstanceSpec): string[] {
  const out: string[] = [];
  const int = (v: number) => Number.isInteger(v);
  if (!int(spec.cpuCores) || spec.cpuCores < 1 || spec.cpuCores > 16) out.push('CPU 核数需为 1–16');
  if (!int(spec.ramMb) || spec.ramMb < 1024 || spec.ramMb > 32768) out.push('内存需为 1024–32768 MB');
  if (!int(spec.width) || spec.width < 320 || spec.width > 3840) out.push('宽度需为 320–3840');
  if (!int(spec.height) || spec.height < 320 || spec.height > 3840) out.push('高度需为 320–3840');
  if (!int(spec.dpi) || spec.dpi < 120 || spec.dpi > 640) out.push('DPI 需为 120–640');
  if (!int(spec.dataPartitionGb) || spec.dataPartitionGb < 2 || spec.dataPartitionGb > 512) out.push('数据盘需为 2–512 GB');
  return out;
}

export function SpecFields({
  value,
  onChange,
  disabled = false,
  showExtraArgs = false,
  showLaunchOptions = true,
}: {
  value: InstanceSpec;
  onChange: (spec: InstanceSpec) => void;
  disabled?: boolean;
  showExtraArgs?: boolean;
  showLaunchOptions?: boolean;
}) {
  const set = <K extends keyof InstanceSpec>(key: K, v: InstanceSpec[K]) => onChange({ ...value, [key]: v });
  const preset = RESOLUTION_PRESETS.find((p) => p.width === value.width && p.height === value.height)?.id ?? 'custom';
  const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

  return (
    <div className="form-grid">
      <label className="field">
        <span className="field-label">CPU 核数</span>
        <select value={value.cpuCores} disabled={disabled} onChange={(e) => set('cpuCores', Number(e.target.value))}>
          {withCurrent(CPU_OPTIONS, value.cpuCores).map((n) => (
            <option key={n} value={n}>
              {n} 核
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">内存</span>
        <select value={value.ramMb} disabled={disabled} onChange={(e) => set('ramMb', Number(e.target.value))}>
          {withCurrent(RAM_OPTIONS, value.ramMb).map((n) => (
            <option key={n} value={n}>
              {formatMb(n)}
            </option>
          ))}
        </select>
      </label>
      <label className="field span-2">
        <span className="field-label">分辨率</span>
        <div className="field-row">
          <select
            value={preset}
            disabled={disabled}
            onChange={(e) => {
              const p = RESOLUTION_PRESETS.find((r) => r.id === e.target.value);
              if (p) onChange({ ...value, width: p.width, height: p.height });
            }}
          >
            {RESOLUTION_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">自定义</option>
          </select>
          <input
            type="number"
            className="num"
            min={320}
            max={3840}
            value={Number.isFinite(value.width) ? value.width : ''}
            disabled={disabled}
            onChange={(e) => set('width', num(e.target.value))}
            aria-label="宽度"
          />
          <span className="field-x">×</span>
          <input
            type="number"
            className="num"
            min={320}
            max={3840}
            value={Number.isFinite(value.height) ? value.height : ''}
            disabled={disabled}
            onChange={(e) => set('height', num(e.target.value))}
            aria-label="高度"
          />
        </div>
      </label>
      <label className="field">
        <span className="field-label">DPI</span>
        <select value={value.dpi} disabled={disabled} onChange={(e) => set('dpi', Number(e.target.value))}>
          {withCurrent(DPI_OPTIONS, value.dpi).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">数据盘（GB）</span>
        <input
          type="number"
          min={2}
          max={512}
          value={Number.isFinite(value.dataPartitionGb) ? value.dataPartitionGb : ''}
          disabled={disabled}
          onChange={(e) => set('dataPartitionGb', num(e.target.value))}
        />
      </label>
      <label className="field">
        <span className="field-label">GPU 渲染</span>
        <select value={value.gpuMode} disabled={disabled} onChange={(e) => set('gpuMode', e.target.value as GpuMode)}>
          {GPU_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field" title="很多 Unity 游戏需要 GLES 3.1 与 ASTC 纹理，翻译层只有 GLES 3.0，会提示“设备不支持”">
        <span className="field-label">GLES 驱动</span>
        <select
          value={value.gpuMode === 'software' ? 'translator' : (value.glDriver ?? 'angle')}
          disabled={disabled || value.gpuMode === 'software'}
          onChange={(e) => set('glDriver', e.target.value as GlDriver)}
        >
          {GL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {showLaunchOptions && (
        <div className="field span-2 checks">
          <label className="check">
            <input type="checkbox" checked={value.headless} disabled={disabled} onChange={(e) => set('headless', e.target.checked)} />
            无窗口运行
            <span className="hint">（通过实时画面 / scrcpy 查看）</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={value.bootMode === 'cold'}
              disabled={disabled}
              onChange={(e) => set('bootMode', e.target.checked ? 'cold' : 'quick')}
            />
            每次冷启动
            <span className="hint">（不使用快速启动快照）</span>
          </label>
        </div>
      )}
      {showExtraArgs && (
        <label className="field span-2">
          <span className="field-label">额外模拟器参数</span>
          <ArgsInput value={value.extraArgs} disabled={disabled} placeholder="例如 -no-audio" onChange={(args) => set('extraArgs', args)} />
        </label>
      )}
    </div>
  );
}

/** Text input for an argv list; keeps the raw text while typing so spaces/quotes are not eaten. */
export function ArgsInput({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string[];
  onChange: (args: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => joinArgs(value));
  useEffect(() => {
    // Adopt external changes only (not our own echo).
    setText((cur) => (joinArgs(splitArgs(cur)) === joinArgs(value) ? cur : joinArgs(value)));
  }, [value]);
  return (
    <input
      type="text"
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        onChange(splitArgs(e.target.value));
      }}
    />
  );
}
