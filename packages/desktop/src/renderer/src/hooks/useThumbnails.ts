import { useEffect, useReducer, useRef } from 'react';
import { avdm } from '../api';
import { useAvdmEvent } from './useAvdmEvent';

const THUMB_WIDTH = 320;
const THUMB_INTERVAL_MS = 2000;

/**
 * Subscribes the main process to thumbnail polling for `indices` and returns index → blob URL.
 * Old blob URLs are revoked as soon as they are replaced or their instance leaves the set.
 */
export function useThumbnails(indices: number[]): ReadonlyMap<number, string> {
  const urls = useRef(new Map<number, string>());
  const active = useRef(new Set<number>());
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const key = [...indices].sort((a, b) => a - b).join(',');

  useEffect(() => {
    const list = key ? key.split(',').map(Number) : [];
    active.current = new Set(list);
    let changed = false;
    for (const [index, url] of urls.current) {
      if (!active.current.has(index)) {
        URL.revokeObjectURL(url);
        urls.current.delete(index);
        changed = true;
      }
    }
    if (changed) bump();
    avdm.setThumbnailSubscription(list, { width: THUMB_WIDTH, intervalMs: THUMB_INTERVAL_MS }).catch(() => undefined);
  }, [key]);

  useEffect(() => {
    const map = urls.current;
    return () => {
      avdm.setThumbnailSubscription([]).catch(() => undefined);
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  useAvdmEvent('thumbnail', (frame) => {
    if (!active.current.has(frame.index)) return;
    const url = URL.createObjectURL(new Blob([frame.png as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
    const old = urls.current.get(frame.index);
    urls.current.set(frame.index, url);
    if (old) URL.revokeObjectURL(old);
    bump();
  });

  return urls.current;
}
