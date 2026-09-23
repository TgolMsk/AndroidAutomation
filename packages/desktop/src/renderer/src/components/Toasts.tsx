import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BatchResult } from '../../../shared/ipc';
import { summarize } from '../api';
import { Icon } from './Icon';

export type ToastKind = 'success' | 'error' | 'info' | 'warn';

export interface ToastInput {
  kind: ToastKind;
  title: string;
  detail?: string | string[];
  action?: { label: string; onClick: () => void };
  /** ms; default 4s (errors 8s). 0 = sticky. */
  duration?: number;
}

interface Toast extends ToastInput {
  id: number;
}

interface ToastApi {
  push: (t: ToastInput) => number;
  dismiss: (id: number) => void;
  /** Summarise a batch result ("启动：成功 3 个，失败 1 个" + failure details). */
  batch: (label: string, results: BatchResult<unknown>[], names?: (index: number) => string) => void;
  error: (title: string, err?: unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const MAX_TOASTS = 6;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const push = useCallback((t: ToastInput) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { ...t, id }].slice(-MAX_TOASTS));
    return id;
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      dismiss,
      batch(label, results, names) {
        if (results.length === 0) return;
        const { ok, failed } = summarize(results);
        const who = (i: number) => (names ? `${names(i)} #${i}` : `#${i}`);
        if (failed.length === 0) {
          push({ kind: 'success', title: `${label}：成功 ${ok} 个` });
        } else {
          push({
            kind: ok > 0 ? 'warn' : 'error',
            title: ok > 0 ? `${label}：成功 ${ok} 个，失败 ${failed.length} 个` : `${label}失败（${failed.length} 个）`,
            detail: failed.map((f) => `${who(f.index)}：${f.error}`),
          });
        }
      },
      error(title, err) {
        const message = err === undefined ? undefined : err instanceof Error ? err.message : String(err);
        push({ kind: 'error', title, detail: message });
      },
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const KIND_ICON = { success: 'check', error: 'alert', warn: 'alert', info: 'info' } as const;

function ToastItem({ toast, onDismiss: dismissById }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [hover, setHover] = useState(false);
  const duration = toast.duration ?? (toast.kind === 'error' || toast.kind === 'warn' ? 8000 : 4000);
  const { id } = toast;
  const onDismiss = useCallback(() => dismissById(id), [dismissById, id]);
  useEffect(() => {
    if (!duration || hover) return;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [duration, hover, onDismiss]);
  const details = toast.detail === undefined ? [] : Array.isArray(toast.detail) ? toast.detail : [toast.detail];
  return (
    <div className={`toast toast-${toast.kind}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} role="status">
      <span className="toast-icon">
        <Icon name={KIND_ICON[toast.kind]} size={16} />
      </span>
      <div className="toast-content">
        <div className="toast-title">{toast.title}</div>
        {details.length > 0 && (
          <div className="toast-detail">
            {details.slice(0, 6).map((d, i) => (
              <div key={i}>{d}</div>
            ))}
            {details.length > 6 && <div>…另有 {details.length - 6} 条</div>}
          </div>
        )}
        {toast.action && (
          <button
            className="link-btn"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button className="icon-btn small" onClick={onDismiss} aria-label="关闭">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
