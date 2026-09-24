/**
 * Compile-once cache of the vision worker (DECISIONS A.7, original gather rule 10): compiled template sets keyed by
 * real directory and manifest stamp, least recently used first. A few sets fit side by side — the instance's own set
 * and a script run's set (AI queries during a script) — so a script consult never evicts the set the next sample or
 * cycle needs. Pure (no worker, no OpenCV) so it can be tested on its own.
 */
export class CompiledSetCache<T> {
  private readonly sets = new Map<string, { stamp: string; value: T }>();
  /** Compiles in flight by directory, shared by a job and the queries that arrive meanwhile (never compile twice). */
  private readonly pending = new Map<string, { stamp: string; promise: Promise<T> }>();
  /** Bumped by `clear`: a compile that started before it never becomes the cache. */
  private generation = 0;

  constructor(private readonly capacity = 3) {}

  get size(): number { return this.sets.size; }

  async get(dir: string, stamp: string, compile: () => Promise<T>): Promise<T> {
    const cached = this.sets.get(dir);
    if (cached && cached.stamp === stamp) {
      this.sets.delete(dir);
      this.sets.set(dir, cached);
      return cached.value;
    }
    const inflight = this.pending.get(dir);
    if (inflight && inflight.stamp === stamp) return inflight.promise;
    const started = this.generation;
    const promise = compile();
    this.pending.set(dir, { stamp, promise });
    try {
      const value = await promise;
      if (this.generation === started) {
        this.sets.delete(dir);
        this.sets.set(dir, { stamp, value });
        for (const oldest of this.sets.keys()) {
          if (this.sets.size <= this.capacity) break;
          this.sets.delete(oldest);
        }
      }
      return value;
    } finally {
      if (this.pending.get(dir)?.promise === promise) this.pending.delete(dir);
    }
  }

  /** Drop every compiled set (template library changed). */
  clear(): void {
    this.sets.clear();
    this.pending.clear();
    this.generation++;
  }
}
