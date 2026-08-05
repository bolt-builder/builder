/**
 * Host Flutter SDK detection (server-side only).
 *
 * Mirrors the cached `isGitAvailable()` pattern from the git manager: probe
 * once per server process and remember the answer. Used to conditionally
 * unlock Flutter guidance in the AI system prompt — the model should only
 * be allowed to generate Flutter projects when the host machine can
 * actually run them.
 */

import { execSync } from 'child_process';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('FlutterDetect');

let cachedAvailability: boolean | undefined;

/**
 * Check whether the Flutter SDK is installed and on PATH.
 * The result is cached for the lifetime of the server process.
 */
export function isFlutterAvailable(): boolean {
  if (cachedAvailability !== undefined) {
    return cachedAvailability;
  }

  try {
    execSync('flutter --version', { stdio: 'pipe', timeout: 15000 });
    cachedAvailability = true;
    logger.info('Flutter SDK detected on host — Flutter project support enabled');
  } catch {
    cachedAvailability = false;
    logger.debug('Flutter SDK not found on host — Flutter project support disabled');
  }

  return cachedAvailability;
}
