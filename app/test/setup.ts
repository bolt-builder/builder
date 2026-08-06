/// <reference types="vitest/globals" />
import '@testing-library/jest-dom/vitest';

/*
 * Global test setup for Bolt.
 * This file runs before each test suite via vitest setupFiles.
 */

// Mock process.env defaults for tests
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

// Suppress noisy console output during tests unless DEBUG_TESTS is set
if (!process.env.DEBUG_TESTS) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const noop = () => {};
  vi.spyOn(console, 'warn').mockImplementation(noop);
  vi.spyOn(console, 'debug').mockImplementation(noop);
}

// Clean up after each test to prevent state leakage
afterEach(() => {
  vi.restoreAllMocks();
});
