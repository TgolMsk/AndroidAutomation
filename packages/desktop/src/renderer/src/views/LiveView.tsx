import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { InstanceState, TouchPoint } from '@avdm/core';
import type { DisplayRotation } from '../../../shared/ipc';
import { avdm, errMsg } from '../api';
import { Icon } from '../components/Icon';
import { Spinner, StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toasts';
import { displayStatus, hasNonAscii, hasScreen } from '../format';
import { useAvdmEvent } from '../hooks/useAvdmEvent';
import { frameRateLabel, type FrameRateLabel } from '../live/frameRate';
import { FrameRenderer } from '../live/frameRenderer';
import { uprightSize, uprightToPanel } from '../live/rotation';

type LiveStatus = 'connecting' | 'live' | 'ended' | 'error';

const IGNORED_KEYS = new Set(['Dead', 'Unidentified', 'Meta', 'OS', 'Fn', 'FnLock', 'Hyper', 'Super']);
/** Minimum gap between repeated "not supported" hints while the user keeps typing. */
const INPUT_HINT_INTERVAL_MS = 15_000;
const RATE_HINT = '模拟器只在画面变化时推送新帧：画面不动时没有新帧属于正常现象';

/** Live control window: gRPC frame stream on a canvas, pointer → touch, keyboard → key events. */
export function LiveView({ index }: { index: number }) {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const renderer = useRef<FrameRenderer | null>(null);
  /** Panel size (touch space) and the rotation the picture is shown with. */
  const device = useRef<{ w: number; h: number; r: DisplayRotation }>({ w: 0, h: 0, r: 0 });
  const liveRef = useRef(false);
  const frames = useRef(0);
  const lastFrameAt = useRef(0);
  const lastInputHint = useRef(0);

  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [message, setMessage] = useState<string>();
  const [instance, setInstance] = useState<InstanceState>();
  const [frameSize, setFrameSize] = useState<{ w: number; h: number }>();
  const [aspect, setAspect] = useState<number>();
  const [cssSize, setCssSize] = useState<{ width: number; height: number }>();
  const [rate, setRate] = useState<FrameRateLabel>({ text: '', idle: false });
  const [attempt, setAttempt] = useState(0);
  const [shooting, setShooting] = useState(false);
  const [onTop, setOnTop] = useState(false);

  liveRef.current = status === 'live';

  // ── instance info ──
  useEffect(() => {
    avdm
      .listInstances()
      .then((list) => {
        const s = list.find((x) => x.record.index === index);
        if (s) setInstance(s);
      })
      .catch(() => undefined);
  }, [index]);

  useEffect(() => {
    if (instance) document.title = `${instance.record.name} #${index}`;
    if (instance && !aspect && instance.record.spec.height > 0) setAspect(instance.record.spec.width / instance.record.spec.height);
  }, [instance, index, aspect]);

  const statusRef = useRef(status);
  statusRef.current = status;
  const instanceRef = useRef(instance);
  instanceRef.current = instance;
  useAvdmEvent('instance-state', (s) => {
    if (s.record.index !== index) return;
    const prev = instanceRef.current;
    // Came back up after a stop/crash while we were disconnected → reconnect automatically.
    if (prev && !hasScreen(prev) && hasScreen(s) && (statusRef.current === 'ended' || statusRef.current === 'error')) {
      setAttempt((a) => a + 1);
    }
    setInstance(s);
  });

  // ── stream lifecycle ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = new FrameRenderer(canvas, (f) => {
      frames.current++;
      lastFrameAt.current = Date.now();
      const up = uprightSize(f.width, f.height, f.rotation ?? 0);
      setFrameSize((prev) => (prev && prev.w === up.width && prev.h === up.height ? prev : { w: up.width, h: up.height }));
    });
    renderer.current = r;
    return () => {
      r.dispose();
      renderer.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('connecting');
    setMessage(undefined);
    const stageWidth = stageRef.current?.clientWidth || window.innerWidth;
    const maxWidth = Math.round(stageWidth * (window.devicePixelRatio || 1));
    avdm
      .liveStart(index, { maxWidth })
      .then((d) => {
        if (cancelled) return;
        device.current = { w: d.deviceWidth, h: d.deviceHeight, r: 0 };
        setAspect((a) => a ?? d.deviceWidth / d.deviceHeight);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setMessage(errMsg(err));
      });
    return () => {
      cancelled = true;
      avdm.liveStop(index).catch(() => undefined);
    };
  }, [index, attempt]);

  useAvdmEvent('live-frame', (frame) => {
    if (frame.index !== index) return;
    const rotation = frame.rotation ?? 0;
    device.current = { w: frame.deviceWidth, h: frame.deviceHeight, r: rotation };
    renderer.current?.push(frame);
    if (statusRef.current !== 'live') {
      lastFrameAt.current = Date.now();
      setStatus('live');
    }
    const up = uprightSize(frame.width, frame.height, rotation);
    const a = up.width / up.height;
    setAspect((prev) => (prev && Math.abs(prev - a) < 0.01 ? prev : a));
  });

  useAvdmEvent('live-ended', (e) => {
    if (e.index !== index) return;
    setStatus('ended');
    setMessage(e.error ?? '画面流已结束');
  });

  // Frame-rate indicator: the emulator streams only on change, so "no frames" usually means a static
  // screen (画面静止); a stalled stream is detected by the main process and ends the session.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = frameRateLabel(frames.current, Date.now() - lastFrameAt.current);
      frames.current = 0;
      setRate((prev) => (prev.text === next.text && prev.idle === next.idle ? prev : next));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // ── always on top (置顶) ──
  useEffect(() => {
    avdm
      .alwaysOnTop()
      .then(setOnTop)
      .catch(() => undefined);
  }, []);
  useAvdmEvent('window-state', (s) => setOnTop(s.alwaysOnTop));
  const toggleOnTop = () => {
    avdm
      .alwaysOnTop(!onTop)
      .then(setOnTop)
      .catch((err: unknown) => toast.error('无法切换置顶', errMsg(err)));
  };

  // ── fit canvas to the stage keeping the aspect ratio ──
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !aspect) return;
    const fit = () => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (!w || !h) return;
      const width = Math.min(w, h * aspect);
      setCssSize({ width: Math.floor(width), height: Math.floor(width / aspect) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [aspect]);

  // ── input ──
  const sendTouch = useCallback(
    (touches: TouchPoint[]) => {
      avdm.liveTouch(index, touches).catch(() => undefined);
    },
    [index],
  );

  const pointer = useRef({ active: false, id: -1, x: 0, y: 0, lastX: -1, lastY: -1, raf: 0 });

  /** Pointer position on the (upright) canvas → panel pixels, the coordinate space gRPC touches use. */
  const toDevice = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const d = device.current;
    if (!canvas || !d.w || !d.h) return undefined;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    return uprightToPanel((clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height, d.r, d.w, d.h);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || statusRef.current !== 'live') return;
    const p = toDevice(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    const ptr = pointer.current;
    Object.assign(ptr, { active: true, id: e.pointerId, x: p.x, y: p.y, lastX: p.x, lastY: p.y });
    sendTouch([{ x: p.x, y: p.y, id: 0, pressure: 1 }]);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const ptr = pointer.current;
    if (!ptr.active || e.pointerId !== ptr.id) return;
    const p = toDevice(e.clientX, e.clientY);
    if (!p) return;
    ptr.x = p.x;
    ptr.y = p.y;
    if (ptr.raf) return;
    // Throttle moves to one per animation frame.
    ptr.raf = requestAnimationFrame(() => {
      ptr.raf = 0;
      if (!ptr.active || (ptr.x === ptr.lastX && ptr.y === ptr.lastY)) return;
      ptr.lastX = ptr.x;
      ptr.lastY = ptr.y;
      sendTouch([{ x: ptr.x, y: ptr.y, id: 0, pressure: 1 }]);
    });
  };

  const endPointer = (e: ReactPointerEvent<HTMLCanvasElement>, useEventPos: boolean) => {
    const ptr = pointer.current;
    if (!ptr.active || e.pointerId !== ptr.id) return;
    ptr.active = false;
    if (ptr.raf) cancelAnimationFrame(ptr.raf);
    ptr.raf = 0;
    const p = useEventPos ? (toDevice(e.clientX, e.clientY) ?? { x: ptr.x, y: ptr.y }) : { x: ptr.x, y: ptr.y };
    sendTouch([{ x: p.x, y: p.y, id: 0, pressure: 0 }]);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const sendKey = useCallback(
    (key: string) => {
      avdm.liveKey(index, { key }).catch((err: unknown) => toast.error('按键发送失败', errMsg(err)));
    },
    [index, toast],
  );

  useEffect(() => {
    // The emulator's key channel only types ASCII and drops anything else without an error: say so.
    const hintUnsupportedInput = () => {
      const now = Date.now();
      if (now - lastInputHint.current < INPUT_HINT_INTERVAL_MS) return;
      lastInputHint.current = now;
      toast.push({
        kind: 'warn',
        title: '实时画面暂不支持中文等非 ASCII 输入',
        detail: '模拟器的按键通道只能输入 ASCII 字符，其他字符会被丢弃。请切换到英文输入法，或在设备内使用输入法输入。',
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (!liveRef.current || e.metaKey) return; // ⌘ shortcuts belong to the app menu
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.isComposing || e.key === 'Process' || e.keyCode === 229 || (e.key.length === 1 && hasNonAscii(e.key))) {
        // IME composition / non-ASCII characters cannot be delivered.
        e.preventDefault();
        if (e.type === 'keydown') hintUnsupportedInput();
        return;
      }
      if (IGNORED_KEYS.has(e.key)) return;
      e.preventDefault();
      avdm.liveKey(index, { key: e.key, eventType: e.type === 'keydown' ? 'keydown' : 'keyup' }).catch(() => undefined);
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (!text || !liveRef.current) return;
      e.preventDefault();
      if (hasNonAscii(text)) {
        // Sending it would silently drop those characters ("hi 世界!" arrives as "hi !"): refuse the whole paste.
        toast.push({
          kind: 'warn',
          title: '无法粘贴中文等非 ASCII 字符',
          detail: '模拟器的按键通道只能输入 ASCII 字符，其他字符会被丢弃，本次粘贴已取消。',
        });
        return;
      }
      avdm.liveKey(index, { text }).catch((err: unknown) => toast.error('粘贴失败', errMsg(err)));
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [index, toast]);

  const screenshot = async () => {
    setShooting(true);
    try {
      const file = await avdm.saveScreenshot(index);
      toast.push({ kind: 'success', title: '截图已保存', detail: file, action: { label: '在 Finder 中显示', onClick: () => void avdm.revealPath(file) } });
    } catch (err) {
      toast.error('截图失败', errMsg(err));
    } finally {
      setShooting(false);
    }
  };

  const connected = status === 'live';
  const ds = instance ? displayStatus(instance) : undefined;

  return (
    <div className="live">
      <div className="live-toolbar">
        <div className="live-nav">
          <button className="live-btn" onClick={() => sendKey('GoBack')} disabled={!connected} title="返回">
            <Icon name="back" size={16} />
            <span>返回</span>
          </button>
          <button className="live-btn" onClick={() => sendKey('GoHome')} disabled={!connected} title="主页">
            <Icon name="home" size={15} />
            <span>主页</span>
          </button>
          <button className="live-btn" onClick={() => sendKey('AppSwitch')} disabled={!connected} title="多任务">
            <Icon name="recents" size={14} />
            <span>多任务</span>
          </button>
        </div>
        <div className="live-info">
          {ds && <StatusBadge status={ds} />}
          {connected && frameSize && (
            <span className="mono dim">
              {frameSize.w}×{frameSize.h}
              {rate.text && (
                <>
                  {' · '}
                  <span className={`live-rate${rate.idle ? ' idle' : ''}`} title={RATE_HINT}>
                    {rate.text}
                  </span>
                </>
              )}
            </span>
          )}
        </div>
        <button className="live-btn" onClick={() => void screenshot()} disabled={shooting || !instance || !hasScreen(instance)} title="保存截图到 图片/avdm">
          {shooting ? <Spinner size={13} /> : <Icon name="camera" size={16} />}
          <span>截图</span>
        </button>
        <button
          className={`live-btn${onTop ? ' active' : ''}`}
          onClick={toggleOnTop}
          aria-pressed={onTop}
          title={onTop ? '取消置顶' : '窗口置顶（显示在其他窗口之上）'}
        >
          <Icon name="pin" size={15} />
          <span>置顶</span>
        </button>
      </div>
      <div className="live-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="live-canvas"
          tabIndex={0}
          style={cssSize ? { width: cssSize.width, height: cssSize.height } : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endPointer(e, true)}
          onPointerCancel={(e) => endPointer(e, false)}
          onLostPointerCapture={(e) => endPointer(e, false)}
          onContextMenu={(e) => e.preventDefault()}
        />
        {status !== 'live' && (
          <div className="live-overlay">
            {status === 'connecting' ? (
              <>
                <Spinner size={24} />
                <div>正在连接画面…</div>
              </>
            ) : (
              <>
                <Icon name={status === 'error' ? 'alert' : 'screen'} size={30} />
                <div className="live-overlay-msg">{message}</div>
                <button className="btn primary" onClick={() => setAttempt((a) => a + 1)}>
                  <Icon name="refresh" />
                  重新连接
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
