import type { DeviceBuildProfile, DeviceIdentity, DeviceIdentityInput } from '@avdm/core';

export function IdentityFields({ value, onChange, disabled = false }: {
  value: DeviceIdentityInput;
  onChange: (value: DeviceIdentityInput) => void;
  disabled?: boolean;
}) {
  const mode = typeof value === 'string' ? value : 'template';
  const template: DeviceIdentity = typeof value === 'object' ? value : {};
  const setMode = (next: string) => {
    if (next === 'system' || next === 'random') onChange(next);
    else onChange({ serialNumber: 'random', wifiMac: 'random', androidId: 'random' });
  };
  const setField = (key: 'serialNumber' | 'wifiMac' | 'androidId', text: string) => {
    const next = { ...template };
    if (text) next[key] = text;
    else delete next[key];
    onChange(next);
  };
  const setBuildField = (key: keyof DeviceBuildProfile, text: string) => {
    const build = template.build ?? { brand: '', manufacturer: '', model: '', device: '', product: '', fingerprint: '' };
    onChange({ ...template, build: { ...build, [key]: text } });
  };
  return (
    <>
      <div className="section-title">设备标识</div>
      <div className="form-grid">
        <label className="field span-2">
          <span className="field-label">方案</span>
          <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={disabled}>
            <option value="system">模拟器默认</option>
            <option value="random">为每个实例生成随机序列号、Wi-Fi MAC 和 Android ID</option>
            <option value="template">自定义模板</option>
          </select>
        </label>
        {mode === 'template' && (
          <>
            <label className="field">
              <span className="field-label">系统序列号</span>
              <input value={template.serialNumber ?? ''} onChange={(e) => setField('serialNumber', e.target.value)} disabled={disabled} placeholder="random 或自定义序列号" />
            </label>
            <label className="field">
              <span className="field-label">Wi-Fi MAC</span>
              <input value={template.wifiMac ?? ''} onChange={(e) => setField('wifiMac', e.target.value)} disabled={disabled} placeholder="random 或 02:aa:bb:cc:dd:{indexHex2}" />
            </label>
            <label className="field span-2">
              <span className="field-label">Android ID（系统值 + 应用级种子轮换）</span>
              <input value={template.androidId ?? ''} onChange={(e) => setField('androidId', e.target.value)} disabled={disabled} placeholder="random 或 16 位十六进制" />
            </label>
            <label className="check span-2">
              <input type="checkbox" checked={!!template.build} disabled={disabled} onChange={(e) => onChange(e.target.checked
                ? { ...template, build: { brand: '', manufacturer: '', model: '', device: '', product: '', fingerprint: '' } }
                : { ...template, build: undefined })} />
              配置应用可见的机型与构建属性
            </label>
            {template.build && (
              <>
                {(['brand', 'manufacturer', 'model', 'device', 'product'] as const).map((key) => (
                  <label className="field" key={key}>
                    <span className="field-label">{key}</span>
                    <input value={template.build?.[key] ?? ''} onChange={(e) => setBuildField(key, e.target.value)} disabled={disabled} placeholder={{ brand: 'google', manufacturer: 'Google', model: 'Pixel 8', device: 'shiba', product: 'shiba' }[key]} />
                  </label>
                ))}
                <label className="field span-2">
                  <span className="field-label">构建指纹</span>
                  <input value={template.build.fingerprint} onChange={(e) => setBuildField('fingerprint', e.target.value)} disabled={disabled} placeholder="brand/product/device:15/ID/incremental:user/release-keys" />
                </label>
              </>
            )}
          </>
        )}
      </div>
      <div className="hint block">
        序列号、MAC 和 Android ID 可填 random；序列号和 MAC 还可用 {'{index}'}、{'{indexHex2}'}。Android ID 修改时会轮换应用级种子，原有应用 ID 会变化，各应用得到的值仍不同。
        机型模板需与镜像的 Android 版本一致；首次启用会下载官方 Magisk 工具，经校验后设置属性并重启应用运行时。普通应用读取序列号和 MAC 仍受系统权限限制；IMEI 暂不可配置。
      </div>
    </>
  );
}
