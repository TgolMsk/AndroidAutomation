/**
 * Type tools shared by the per-domain IPC contracts. Types and constants only: this file is imported by the
 * main process, the sandboxed preload and the renderer.
 */

/** `true` only when both unions contain exactly the same members. */
export type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to compile unless `T` is `true`. */
export type Assert<T extends true> = T;

/**
 * `true` when a domain's method tuple lists every method of its API interface and nothing else.
 *
 * Every domain file asserts it: `export type XxxContractCheck = Assert<ListsExactly<XxxApi, typeof XXX_METHODS>>`.
 * A compile error "Type 'false' does not satisfy the constraint 'true'" there means a method was added to the
 * interface but not to the tuple (the handler would never be registered and the preload would never wire it).
 * Unknown names in the tuple are rejected earlier by `satisfies readonly (keyof XxxApi)[]`.
 */
export type ListsExactly<Shape, Names extends readonly PropertyKey[]> = Exact<keyof Shape, Names[number]>;

/** Methods that are missing from a tuple, for readable diagnostics in editors (`type X = MissingNames<…>`). */
export type MissingNames<Shape, Names extends readonly PropertyKey[]> = Exclude<keyof Shape, Names[number]>;

/**
 * What the preload returns for every assistant method: errors travel as data so the renderer can rebuild
 * them with their code (Electron's structured clone drops custom properties of thrown errors).
 */
export type WanlongEnvelope<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; code?: string } };

/** An API interface as the preload exposes it: every method resolves to an envelope instead of throwing. */
export type EnvelopedApi<Api> = {
  [K in keyof Api]: Api[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => Promise<WanlongEnvelope<Awaited<R>>> : never;
};
