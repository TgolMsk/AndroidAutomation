/**
 * Live credentials the app log must never write (original iron rule 15 / AI rule 5). Main process only: nothing
 * here is ever sent across IPC or logged.
 *
 * A saved credential only exists in plaintext after it passed through its codec (typed in by the user and encrypted,
 * or decrypted for use), so wrapping the codec is enough to know every plaintext this process could print.
 */
export interface SecretCodecLike {
  encrypt(plain: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/** At most this many values are remembered (a replaced token stays scrubbed for a while; nothing grows unbounded). */
const MAX_SECRETS = 8;
/** Shorter strings would scrub ordinary words; real tokens and keys are far longer. */
const MIN_SECRET_LENGTH = 6;

/** A small bounded set of plaintext secrets, newest last. */
export class SecretMemory {
  private readonly values: string[] = [];

  remember(value: string | null | undefined): void {
    if (typeof value !== 'string') return;
    const secret = value.trim();
    if (secret.length < MIN_SECRET_LENGTH) return;
    const at = this.values.indexOf(secret);
    if (at >= 0) this.values.splice(at, 1);
    this.values.push(secret);
    if (this.values.length > MAX_SECRETS) this.values.splice(0, this.values.length - MAX_SECRETS);
  }

  list(): readonly string[] {
    return this.values;
  }
}

/**
 * `inner` (resolved per call, like the lazy safeStorage codec) with every plaintext that goes in or comes out
 * remembered in `memory` before it is returned to the caller.
 */
export function rememberingCodec(inner: () => Promise<SecretCodecLike>, memory: SecretMemory): SecretCodecLike {
  return {
    async encrypt(plain) {
      memory.remember(plain);
      return (await inner()).encrypt(plain);
    },
    async decrypt(ciphertext) {
      const plain = await (await inner()).decrypt(ciphertext);
      memory.remember(plain);
      return plain;
    },
  };
}
