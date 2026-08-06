/**
 * Preview Error Handler
 *
 * Handles preview errors with cooldown, deduplication, and intelligent filtering
 * to prevent the same error from triggering multiple alerts and to suppress
 * non-actionable errors that would only confuse users.
 *
 * Features:
 * - Error suppression for known non-actionable issues (source maps, 3D lib buffers)
 * - Severity classification (critical, warning, info)
 * - User-friendly error messages
 * - Cooldown and deduplication
 * - Auto-fix integration for code errors
 */

/* NOTE: workbenchStore is imported lazily inside handlePreviewMessage() to avoid circular dependency */
import { cleanStackTrace } from '~/utils/stacktrace';
import { createScopedLogger } from '~/utils/logger';
import {
  shouldSuppressError,
  getUserFriendlyMessage,
  classifyErrorSeverity,
  SEVERITY_CONFIG,
} from '~/utils/errors/errorConfig';
import { classifyError, shouldShowFullAlert } from '~/lib/errors/error-classifier';
import { showErrorToast } from '~/lib/errors/error-toast';

const logger = createScopedLogger('PreviewErrorHandler');

/**
 * Simple hash function for error deduplication
 */
function hashError(error: string): string {
  let hash = 0;
  const cleanError = error.replace(/\d+/g, 'N').slice(0, 200); // Normalize numbers, limit length

  for (let i = 0; i < cleanError.length; i++) {
    const char = cleanError.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  return hash.toString(16);
}

/**
 * Preview Error Handler class
 * Handles cooldown and deduplication for preview errors
 */
class PreviewErrorHandler {
  #lastAlertTime: number = 0;
  #recentErrorHashes: Map<string, number> = new Map();
  #isEnabled: boolean = true;
  #cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  // Configuration constants
  #COOLDOWN_MS = 5000; // 5 seconds cooldown between alerts
  #HASH_TTL_MS = 60000; // Clear hashes after 1 minute

  constructor() {
    // Clean up old hashes periodically - store interval ID for cleanup
    this.#cleanupIntervalId = setInterval(() => this.#cleanupOldHashes(), this.#HASH_TTL_MS);
  }

  /**
   * Cleanup resources when handler is no longer needed
   * Call this method to prevent memory leaks
   */
  destroy(): void {
    if (this.#cleanupIntervalId) {
      clearInterval(this.#cleanupIntervalId);
      this.#cleanupIntervalId = null;
    }

    this.#recentErrorHashes.clear();
    logger.debug('PreviewErrorHandler destroyed');
  }

  /**
   * Enable/disable error handling
   */
  setEnabled(enabled: boolean): void {
    this.#isEnabled = enabled;
    logger.debug(`Preview error handling ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Handle a preview error message from the runtime
   */
  async handlePreviewMessage(message: {
    type: string;
    message?: string;
    stack?: string;
    pathname?: string;
    search?: string;
    hash?: string;
    port?: number;
  }): Promise<void> {
    if (!this.#isEnabled) {
      return;
    }

    // Handle both uncaught exceptions and unhandled promise rejections
    if (message.type !== 'PREVIEW_UNCAUGHT_EXCEPTION' && message.type !== 'PREVIEW_UNHANDLED_REJECTION') {
      return;
    }

    const now = Date.now();
    const errorMessage = message.message || 'Unknown error';
    const fullErrorContext = `${errorMessage} ${message.stack || ''}`;
    const isPromise = message.type === 'PREVIEW_UNHANDLED_REJECTION';

    // Check if error should be suppressed (non-actionable errors)
    if (shouldSuppressError(fullErrorContext, 'preview')) {
      logger.debug(`Suppressing non-actionable preview error: ${errorMessage.slice(0, 100)}`);

      return;
    }

    // Classify error severity
    const severity = classifyErrorSeverity(errorMessage, message.stack);

    // Only show alerts for critical and warning errors
    if (!SEVERITY_CONFIG[severity].showAlert) {
      logger.debug(`Skipping ${severity} severity preview error (no alert): ${errorMessage.slice(0, 100)}`);

      return;
    }

    // Generate error hash for deduplication
    const errorHash = hashError(errorMessage + (message.stack || ''));

    // Check cooldown
    if (now - this.#lastAlertTime < this.#COOLDOWN_MS) {
      logger.debug('Skipping preview alert due to cooldown');

      return;
    }

    // Check deduplication
    if (this.#recentErrorHashes.has(errorHash)) {
      logger.debug('Skipping duplicate preview error');

      return;
    }

    // Mark error as seen
    this.#recentErrorHashes.set(errorHash, now);
    this.#lastAlertTime = now;

    // Get user-friendly message if available
    const friendlyMessage = getUserFriendlyMessage(errorMessage);

    // Create title and description
    const title = friendlyMessage?.title || (isPromise ? 'Unhandled Promise Rejection' : 'Uncaught Exception');
    const description = friendlyMessage?.description || errorMessage;
    const suggestion = friendlyMessage?.suggestion || '';

    // Classify via the new error classifier to decide alert vs toast
    const classified = classifyError(errorMessage);

    if (!shouldShowFullAlert(classified)) {
      // Warning / info severity → lightweight toast instead of full dialog
      showErrorToast({
        ...classified,
        message: `${title}: ${description}`,
        suggestion: suggestion || classified.suggestion,
      });

      logger.info(`Preview warning toast [${classified.category}]: ${title} - ${errorMessage.slice(0, 100)}`);

      return;
    }

    // Fatal / error severity → full ChatAlert dialog
    const contentParts: string[] = [];
    contentParts.push(`Error occurred at ${message.pathname || '/'}${message.search || ''}${message.hash || ''}`);
    contentParts.push(`Port: ${message.port || 'unknown'}`);

    if (suggestion) {
      contentParts.push(`\n💡 Suggestion: ${suggestion}`);
    }

    contentParts.push(`\n\nStack trace:\n${cleanStackTrace(message.stack || '')}`);

    const content = contentParts.join('\n');

    /*
     * Preview errors are NOT auto-fixed — always show the alert and let the user
     * decide whether to ask Bolt for help. Auto-fix from previews was too aggressive,
     * triggering on transient build errors (e.g., missing files while AI is still writing)
     * and wasting tokens on unnecessary LLM calls.
     */

    /* Lazy import to avoid circular dependency */
    const { workbenchStore } = await import('~/lib/stores/workbench');

    workbenchStore.actionAlert.set({
      type: 'preview',
      title,
      description,
      content,
      source: 'preview',
    });

    logger.info(
      `Preview error detected [${severity}/${classified.category}]: ${title} - ${errorMessage.slice(0, 100)}`,
    );
  }

  /**
   * Reset the handler state
   * Call this when user clicks "Ask Bolt" so the same error can be caught again
   */
  reset(): void {
    this.#recentErrorHashes.clear();
    this.#lastAlertTime = 0;
    logger.debug('Preview error handler reset');
  }

  #cleanupOldHashes(): void {
    const now = Date.now();

    for (const [hash, timestamp] of this.#recentErrorHashes) {
      if (now - timestamp > 60_000) {
        this.#recentErrorHashes.delete(hash);
      }
    }
  }
}

// Singleton instance
let handlerInstance: PreviewErrorHandler | null = null;

/**
 * Get the singleton preview error handler instance
 */
export function getPreviewErrorHandler(): PreviewErrorHandler {
  if (!handlerInstance) {
    handlerInstance = new PreviewErrorHandler();
  }

  return handlerInstance;
}

/**
 * Reset the preview error handler state
 * Call this when user requests a fix so the same error can be detected again.
 * Only resets internal state — does NOT destroy the singleton so errors
 * continue to be caught after the user clicks "Ask Bolt".
 */
export function resetPreviewErrorHandler(): void {
  if (handlerInstance) {
    handlerInstance.reset();
  }
}
