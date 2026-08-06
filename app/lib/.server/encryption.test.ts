import { randomBytes } from 'node:crypto';

const TEST_KEY_HEX = 'a'.repeat(64);

beforeEach(() => {
  vi.resetModules();
  process.env.BOLT_ENCRYPTION_KEY = TEST_KEY_HEX;
});

afterEach(() => {
  delete process.env.BOLT_ENCRYPTION_KEY;
});

async function loadModule() {
  return import('./encryption') as Promise<typeof import('./encryption')>;
}

describe('encryption module', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('encrypts and decrypts a simple string', async () => {
      const { encrypt, decrypt } = await loadModule();
      const plaintext = 'Hello, World!';
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('handles empty string', async () => {
      const { encrypt, decrypt } = await loadModule();
      const encrypted = encrypt('');
      expect(decrypt(encrypted)).toBe('');
    });

    it('handles Unicode characters', async () => {
      const { encrypt, decrypt } = await loadModule();
      const plaintext = '日本語テスト 🎉 Ñoño café résumé 你好世界 🔐';
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('handles long text (>1KB)', async () => {
      const { encrypt, decrypt } = await loadModule();
      const plaintext = 'x'.repeat(2048);
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
      expect(plaintext.length).toBeGreaterThan(1024);
    });
  });

  describe('encrypt() output format', () => {
    it('returns a base64-encoded string', async () => {
      const { encrypt } = await loadModule();
      const encrypted = encrypt('test');
      expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();

      const decoded = Buffer.from(encrypted, 'base64');

      // IV (12) + authTag (16) + at least 1 byte ciphertext for non-empty input
      expect(decoded.length).toBeGreaterThanOrEqual(12 + 16);
    });

    it('produces unique ciphertext on each call (unique IV)', async () => {
      const { encrypt } = await loadModule();
      const plaintext = 'identical input';
      const encrypted1 = encrypt(plaintext);
      const encrypted2 = encrypt(plaintext);
      expect(encrypted1).not.toBe(encrypted2);

      // Verify the IVs are different
      const iv1 = Buffer.from(encrypted1, 'base64').subarray(0, 12);
      const iv2 = Buffer.from(encrypted2, 'base64').subarray(0, 12);
      expect(iv1.equals(iv2)).toBe(false);
    });
  });

  describe('decrypt() error handling', () => {
    it('rejects invalid base64 content that decodes too short', async () => {
      const { decrypt } = await loadModule();
      const tooShort = Buffer.alloc(10).toString('base64');
      expect(() => decrypt(tooShort)).toThrow('too short');
    });

    it('rejects tampered ciphertext', async () => {
      const { encrypt, decrypt } = await loadModule();
      const encrypted = encrypt('secret data');
      const tampered = Buffer.from(encrypted, 'base64');
      tampered[tampered.length - 1] ^= 0xff;
      expect(() => decrypt(tampered.toString('base64'))).toThrow('Decryption failed');
    });

    it('rejects completely invalid ciphertext of sufficient length', async () => {
      const { decrypt } = await loadModule();
      const garbage = randomBytes(64).toString('base64');
      expect(() => decrypt(garbage)).toThrow('Decryption failed');
    });
  });

  describe('BOLT_ENCRYPTION_KEY validation', () => {
    it('auto-generates a key when env var is missing', async () => {
      delete process.env.BOLT_ENCRYPTION_KEY;

      const { encrypt, decrypt } = await loadModule();
      const plaintext = 'auto-generated key test';
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('throws descriptive error when key is wrong length', async () => {
      process.env.BOLT_ENCRYPTION_KEY = 'tooshort';

      const { encrypt } = await loadModule();
      expect(() => encrypt('test')).toThrow('must be exactly 32 bytes');
    });

    it('accepts a valid hex-encoded key', async () => {
      process.env.BOLT_ENCRYPTION_KEY = randomBytes(32).toString('hex');

      const { encrypt, decrypt } = await loadModule();
      const encrypted = encrypt('hex key test');
      expect(decrypt(encrypted)).toBe('hex key test');
    });

    it('accepts a valid base64-encoded key', async () => {
      process.env.BOLT_ENCRYPTION_KEY = randomBytes(32).toString('base64');

      const { encrypt, decrypt } = await loadModule();
      const encrypted = encrypt('base64 key test');
      expect(decrypt(encrypted)).toBe('base64 key test');
    });
  });
});
