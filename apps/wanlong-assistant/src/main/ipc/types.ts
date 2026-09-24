import type { WebContents } from 'electron';

/** What every handler receives besides its domain services. */
export interface HandlerBase {
  /** The authorized main-window renderer that sent the request. */
  sender: WebContents;
}

/**
 * One handler per method of a domain API. Arguments arrive unvalidated from the renderer: every handler checks
 * them (see `./validate`) before calling a service. A missing or misspelled handler is a compile error.
 */
export type DomainHandlers<Api, Services> = {
  [K in keyof Api]: Api[K] extends (...args: infer A) => Promise<infer R>
    ? (ctx: Services & HandlerBase, ...args: A) => Promise<Awaited<R>>
    : never;
};
