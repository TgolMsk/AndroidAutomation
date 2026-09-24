/**
 * Thumbnails of one template set's images for the list rows (object URLs, loaded on demand, revoked on dispose).
 * Keyed by template id + `updatedAt`, so a re-saved template gets its new image while unchanged ones stay cached.
 */
export class ThumbCache {
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly ready = new Map<string, string | null>();
  private readonly urls: string[] = [];
  private disposed = false;

  constructor(
    private readonly load: (id: string) => Promise<Uint8Array>,
    private readonly makeUrl: (bytes: Uint8Array) => string = (bytes) => URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' })),
    private readonly revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
  ) {}

  private static key(id: string, version: number | string | undefined): string {
    return `${id}|${version ?? ''}`;
  }

  /** The URL when it is already loaded (`null` = failed to load, `undefined` = not loaded yet). */
  peek(id: string, version?: number | string): string | null | undefined {
    return this.ready.get(ThumbCache.key(id, version));
  }

  /** Load once per id + version; a failed load resolves to null (the row keeps its placeholder icon). */
  get(id: string, version?: number | string): Promise<string | null> {
    const key = ThumbCache.key(id, version);
    const known = this.pending.get(key);
    if (known) return known;
    const next = this.load(id).then((bytes) => {
      if (this.disposed) return null;
      const url = this.makeUrl(bytes);
      this.urls.push(url);
      return url;
    }, () => null).then((url) => {
      if (!this.disposed) this.ready.set(key, url);
      return url;
    });
    this.pending.set(key, next);
    return next;
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.urls) this.revoke(url);
    this.urls.length = 0;
    this.pending.clear();
    this.ready.clear();
  }
}
