import { useState } from 'react';
import type { BatchResult } from '../../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { Icon } from '../Icon';
import { Modal } from '../Modal';
import { Spinner } from '../StatusBadge';
import { useToast } from '../Toasts';

export function ShellDialog({ targets, nameOf, onClose }: { targets: number[]; nameOf: (index: number) => string; onClose: () => void }) {
  const toast = useToast();
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BatchResult<string>[]>();
  const [ran, setRan] = useState('');

  const run = async () => {
    const cmd = command.trim();
    if (!cmd) return;
    setBusy(true);
    try {
      const res = await avdm.shell(targets, cmd);
      setResults(res);
      setRan(cmd);
    } catch (err) {
      toast.error('执行失败', errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="执行 Shell 命令"
      subtitle={`adb shell · ${targets.length} 个实例`}
      onClose={onClose}
      busy={busy}
      width={680}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            关闭
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={busy || !command.trim()}>
            {busy ? <Spinner size={12} /> : <Icon name="terminal" />}
            执行
          </button>
        </>
      }
    >
      <div className="shell-input">
        <span className="mono prompt">$</span>
        <input
          type="text"
          className="mono"
          value={command}
          placeholder="例如 getprop ro.build.version.release"
          spellCheck={false}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void run();
          }}
        />
      </div>
      {results && (
        <div className="shell-results">
          {results.map((r) => (
            <div key={r.index} className={`shell-result ${r.ok ? 'ok' : 'bad'}`}>
              <div className="shell-result-head">
                <Icon name={r.ok ? 'check' : 'alert'} size={13} />
                {nameOf(r.index)} #{r.index}
                <span className="dim mono"> $ {ran}</span>
              </div>
              <pre className="mono">{r.ok ? r.value.trimEnd() || '（无输出）' : r.error}</pre>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
