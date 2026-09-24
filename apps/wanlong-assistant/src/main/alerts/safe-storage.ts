import type { SecretCodec } from './store';

/**
 * The Keychain-backed codec (electron safeStorage), resolved per call so this module stays importable in tests.
 * The composition root wraps it with `rememberingCodec` so every plaintext token is scrubbed from the app log.
 */
export async function safeStorageCodec(): Promise<SecretCodec> {
  const electron = await import('electron');
  if (!electron.safeStorage?.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，暂时无法保存或读取 Bot Token');
  return {
    encrypt: async (plain) => electron.safeStorage.encryptString(plain).toString('base64'),
    decrypt: async (ciphertext) => electron.safeStorage.decryptString(Buffer.from(ciphertext, 'base64')),
  };
}
