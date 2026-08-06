import { setDecryptor } from '~/lib/api/cookies';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('InitDecryptor');

/**
 * Register the AES-256-GCM decryption function with the cookie module.
 *
 * Imported as a side-effect from entry.server.tsx so the decryptor is
 * available before any route handler reads encrypted cookie values.
 *
 * If BOLT_ENCRYPTION_KEY is not configured, the import of encryption.ts
 * throws — we catch that and log a warning.  Encrypted cookie values will
 * fall back to their raw ciphertext in that case.
 */
try {
  /*
   * Dynamic import avoids a top-level dependency on encryption.ts whose
   * module-scope key resolution throws when the env var is absent.
   * Top-level await is fine here — this module is server-only (.server dir).
   */
  const { decrypt } = await import('./encryption');
  setDecryptor(decrypt);
  logger.info('Cookie decryptor registered');
} catch (error) {
  logger.warn('Encryption module not available — encrypted cookies will fall back to raw ciphertext:', error);
}
