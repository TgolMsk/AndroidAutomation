import { useCallback, useMemo, useState } from 'react';

export interface Selection {
  selected: ReadonlySet<number>;
  has: (index: number) => boolean;
  toggle: (index: number) => void;
  set: (indices: Iterable<number>) => void;
  clear: () => void;
  selectAll: (indices: number[]) => void;
  invert: (indices: number[]) => void;
  /** Drop indices that no longer exist. */
  prune: (existing: number[]) => void;
}

export function useSelection(): Selection {
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());

  const toggle = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const set = useCallback((indices: Iterable<number>) => setSelected(new Set(indices)), []);
  const clear = useCallback(() => setSelected((prev) => (prev.size ? new Set() : prev)), []);
  const selectAll = useCallback((indices: number[]) => setSelected(new Set(indices)), []);
  const invert = useCallback((indices: number[]) => {
    setSelected((prev) => new Set(indices.filter((i) => !prev.has(i))));
  }, []);
  const prune = useCallback((existing: number[]) => {
    setSelected((prev) => {
      const keep = new Set(existing);
      const next = [...prev].filter((i) => keep.has(i));
      return next.length === prev.size ? prev : new Set(next);
    });
  }, []);

  return useMemo(
    () => ({ selected, has: (i: number) => selected.has(i), toggle, set, clear, selectAll, invert, prune }),
    [selected, toggle, set, clear, selectAll, invert, prune],
  );
}
