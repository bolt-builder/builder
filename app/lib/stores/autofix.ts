/**
 * Auto-Fix Store
 *
 * State management for the automatic error fixing feature.
 * When enabled, errors detected in terminal/preview are automatically
 * sent to the LLM for fixing, up to a configurable max retry count.
 *
 * Session-level safeguards prevent infinite loops:
 * - Total attempt limit across all error types within a rolling window
 * - Cooldown period after a session ends before a new one can start
 * - Error fingerprint tracking: detects recurring errors across fix attempts
 */

import { map, computed } from 'nanostores';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('AutoFixStore');

/**
 * Session-level safeguards to prevent infinite auto-fix loops.
 * When a fix resolves one error but introduces another, the per-error
 * retry counter resets. These limits cap total attempts across ALL
 * error types within a rolling time window.
 */
const MAX_TOTAL_SESSION_ATTEMPTS = 5;
const SESSION_WINDOW_MS = 3 * 60 * 1000; // 3 minutes (was 5)
const SESSION_COOLDOWN_MS = 60_000; // 60 seconds after session ends (was 30)

/** Threshold: if the same error fingerprint occurs this many times, declare a fix loop. */
const FIX_LOOP_THRESHOLD = 3;

/**
 * Rolling session tracker (module-level, not in store to avoid serialization)
 */
let sessionAttemptTimestamps: number[] = [];
let lastSessionEndTime = 0;

/**
 * Record of a single fix attempt
 */
export interface FixAttempt {
  /** When the fix was attempted */
  timestamp: number;

  /** The error that triggered this attempt */
  errorType: string;

  /** Brief error description */
  errorMessage: string;

  /** Full error content for context */
  errorContent: string;

  /** Whether the fix resolved the error */
  wasSuccessful: boolean;

  /** Duration of the fix attempt in ms */
  duration?: number;
}

/**
 * Error source types
 */
export type ErrorSource = 'terminal' | 'preview' | 'build';

/**
 * Auto-fix settings that persist to localStorage
 */
export interface AutoFixSettings {
  /** Whether auto-fix is enabled */
  isEnabled: boolean;

  /** Maximum retry attempts before giving up */
  maxRetries: number;

  /** Delay between fix attempts in ms */
  delayBetweenAttempts: number;

  /** Show notification when auto-fix starts */
  showNotifications: boolean;
}

/**
 * Main auto-fix state
 */
export interface AutoFixState {
  /** Current settings */
  settings: AutoFixSettings;

  /** Number of retries in current fix session */
  currentRetries: number;

  /** Whether we're currently attempting a fix */
  isFixing: boolean;

  /** The current error being fixed */
  currentError: {
    source: ErrorSource;
    type: string;
    message: string;
    content: string;
  } | null;

  /** History of fix attempts in current session */
  fixHistory: FixAttempt[];

  /** Timestamp when current fix session started */
  sessionStartTime: number | null;

  /** Fingerprint occurrence counts — tracks how many times each error fingerprint has been seen */
  fingerprintCounts: Record<string, number>;

  /** Whether auto-fix is paused due to a detected fix loop */
  pausedByLoop: boolean;

  /** The fingerprint that caused the loop pause (for UI display) */
  loopFingerprint: string | null;
}

// Default settings
const DEFAULT_SETTINGS: AutoFixSettings = {
  isEnabled: false,
  maxRetries: 3,
  delayBetweenAttempts: 1000,
  showNotifications: true,
};

// Load settings from localStorage
function loadSettings(): AutoFixSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_SETTINGS;
  }

  try {
    const stored = localStorage.getItem('bolt_autofix_settings');

    if (stored) {
      const parsed = JSON.parse(stored);

      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (error) {
    logger.error('Failed to load auto-fix settings:', error);
  }

  return DEFAULT_SETTINGS;
}

// Save settings to localStorage
function saveSettings(settings: AutoFixSettings): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem('bolt_autofix_settings', JSON.stringify(settings));
  } catch (error) {
    logger.error('Failed to save auto-fix settings:', error);
  }
}

/**
 * Initial state
 */
const initialState: AutoFixState = {
  settings: loadSettings(),
  currentRetries: 0,
  isFixing: false,
  currentError: null,
  fixHistory: [],
  sessionStartTime: null,
  fingerprintCounts: {},
  pausedByLoop: false,
  loopFingerprint: null,
};

/**
 * Main auto-fix store
 */
export const autoFixStore = map<AutoFixState>(initialState);

/**
 * Derived atoms for easy access
 */
export const isAutoFixEnabled = computed(autoFixStore, (state) => state.settings.isEnabled);
export const isAutoFixing = computed(autoFixStore, (state) => state.isFixing);
export const autoFixRetryCount = computed(autoFixStore, (state) => state.currentRetries);
export const isAutoFixPausedByLoop = computed(autoFixStore, (state) => state.pausedByLoop);

/**
 * Update auto-fix settings
 */
export function updateAutoFixSettings(updates: Partial<AutoFixSettings>): void {
  const currentState = autoFixStore.get();
  const newSettings = { ...currentState.settings, ...updates };

  autoFixStore.set({
    ...currentState,
    settings: newSettings,
  });

  saveSettings(newSettings);
  logger.info('Auto-fix settings updated:', updates);
}

/**
 * Toggle auto-fix enabled state
 */
export function toggleAutoFix(enabled?: boolean): void {
  const currentState = autoFixStore.get();
  const newEnabled = enabled ?? !currentState.settings.isEnabled;

  updateAutoFixSettings({ isEnabled: newEnabled });
  logger.info(`Auto-fix ${newEnabled ? 'enabled' : 'disabled'}`);
}

/**
 * Start a new auto-fix session
 */
export function startAutoFix(error: { source: ErrorSource; type: string; message: string; content: string }): boolean {
  const currentState = autoFixStore.get();

  // Check if auto-fix is enabled
  if (!currentState.settings.isEnabled) {
    logger.debug('Auto-fix is disabled, skipping');

    return false;
  }

  // Check if paused by fix loop detection
  if (currentState.pausedByLoop) {
    logger.debug('Auto-fix is paused due to fix loop detection');

    return false;
  }

  // Check session cooldown — prevent rapid re-triggering after a session ends
  const now = Date.now();

  if (lastSessionEndTime > 0 && now - lastSessionEndTime < SESSION_COOLDOWN_MS) {
    const remaining = Math.ceil((SESSION_COOLDOWN_MS - (now - lastSessionEndTime)) / 1000);
    logger.debug(`Auto-fix in cooldown, ${remaining}s remaining`);

    return false;
  }

  /* Check rolling session-level total attempt limit — prune timestamps outside the rolling window */
  sessionAttemptTimestamps = sessionAttemptTimestamps.filter((t) => now - t < SESSION_WINDOW_MS);

  if (sessionAttemptTimestamps.length >= MAX_TOTAL_SESSION_ATTEMPTS) {
    logger.warn(
      `Session-level limit reached (${MAX_TOTAL_SESSION_ATTEMPTS} attempts in ${SESSION_WINDOW_MS / 1000}s window), stopping auto-fix`,
    );

    return false;
  }

  // Check if we've exceeded max retries for this specific error
  if (currentState.currentRetries >= currentState.settings.maxRetries) {
    logger.warn(`Max retries (${currentState.settings.maxRetries}) reached, stopping auto-fix`);

    return false;
  }

  // Check if we're already fixing
  if (currentState.isFixing) {
    logger.debug('Already fixing, queuing error');

    // Could implement a queue here in the future
    return false;
  }

  // Track this attempt in the rolling session window
  sessionAttemptTimestamps.push(now);

  autoFixStore.set({
    ...currentState,
    isFixing: true,
    currentError: error,
    currentRetries: currentState.currentRetries + 1,
    sessionStartTime: currentState.sessionStartTime ?? now,
  });

  logger.info(`Starting auto-fix attempt ${currentState.currentRetries + 1}/${currentState.settings.maxRetries}`, {
    errorType: error.type,
    source: error.source,
  });

  return true;
}

/**
 * Record the result of a fix attempt
 */
export function recordFixAttempt(wasSuccessful: boolean): void {
  const currentState = autoFixStore.get();

  if (!currentState.currentError) {
    logger.warn('No current error to record fix attempt for');

    return;
  }

  const attempt: FixAttempt = {
    timestamp: Date.now(),
    errorType: currentState.currentError.type,
    errorMessage: currentState.currentError.message,
    errorContent: currentState.currentError.content,
    wasSuccessful,
    duration: currentState.sessionStartTime ? Date.now() - currentState.sessionStartTime : undefined,
  };

  autoFixStore.set({
    ...currentState,
    isFixing: false,
    currentError: wasSuccessful ? null : currentState.currentError,
    fixHistory: [...currentState.fixHistory, attempt],
  });

  if (wasSuccessful) {
    logger.info('Auto-fix successful!');
    resetAutoFix();
  } else {
    logger.info(
      `Auto-fix attempt failed, ${currentState.settings.maxRetries - currentState.currentRetries} retries remaining`,
    );
  }
}

/**
 * Mark fix as complete (called when no more errors detected)
 */
export function markFixComplete(): void {
  recordFixAttempt(true);
}

/**
 * Mark fix as failed (called when same/new error detected after fix)
 */
export function markFixFailed(): void {
  recordFixAttempt(false);
}

/**
 * Reset auto-fix state (end of session)
 * Sets a cooldown timer to prevent immediate re-triggering
 */
export function resetAutoFix(): void {
  const currentState = autoFixStore.get();

  autoFixStore.set({
    ...currentState,
    currentRetries: 0,
    isFixing: false,
    currentError: null,
    fixHistory: [],
    sessionStartTime: null,
    fingerprintCounts: {},
    pausedByLoop: false,
    loopFingerprint: null,
  });

  // Set cooldown to prevent immediate re-triggering if the fix created a new error
  lastSessionEndTime = Date.now();

  logger.debug('Auto-fix session reset, cooldown started');
}

/**
 * Check if we should continue attempting fixes.
 * Also checks session-level limits and cooldown.
 */
export function shouldContinueFix(): boolean {
  const state = autoFixStore.get();

  if (
    !state.settings.isEnabled ||
    state.isFixing ||
    state.pausedByLoop ||
    state.currentRetries >= state.settings.maxRetries
  ) {
    return false;
  }

  // Check session cooldown
  const now = Date.now();

  if (lastSessionEndTime > 0 && now - lastSessionEndTime < SESSION_COOLDOWN_MS) {
    return false;
  }

  // Check rolling session-level limit
  const recentAttempts = sessionAttemptTimestamps.filter((t) => now - t < SESSION_WINDOW_MS);

  if (recentAttempts.length >= MAX_TOTAL_SESSION_ATTEMPTS) {
    return false;
  }

  return true;
}

/**
 * Check if we've exceeded max retries (per-error or session-level)
 */
export function hasExceededMaxRetries(): boolean {
  const state = autoFixStore.get();
  const now = Date.now();

  // Per-error retry limit
  if (state.currentRetries >= state.settings.maxRetries) {
    return true;
  }

  // Session-level rolling limit
  const recentAttempts = sessionAttemptTimestamps.filter((t) => now - t < SESSION_WINDOW_MS);

  return recentAttempts.length >= MAX_TOTAL_SESSION_ATTEMPTS;
}

/**
 * Get fix history context for LLM
 * Returns a formatted string of previous fix attempts
 */
export function getFixHistoryContext(): string {
  const state = autoFixStore.get();

  if (state.fixHistory.length === 0) {
    return '';
  }

  const attempts = state.fixHistory
    .map(
      (attempt, index) =>
        `Attempt ${index + 1}: ${attempt.wasSuccessful ? 'Success' : 'Failed'} - ${attempt.errorType}: ${attempt.errorMessage}`,
    )
    .join('\n');

  return `\n**Previous Fix Attempts:**\n${attempts}`;
}

/**
 * Get current fix status for UI display
 */
export function getAutoFixStatus(): {
  isActive: boolean;
  currentAttempt: number;
  maxAttempts: number;
  errorType: string | null;
} {
  const state = autoFixStore.get();

  return {
    isActive: state.isFixing,
    currentAttempt: state.currentRetries,
    maxAttempts: state.settings.maxRetries,
    errorType: state.currentError?.type ?? null,
  };
}

/**
 * Full reset including session-level state.
 * Use in tests and when the user manually clears session state.
 */
export function resetSessionState(): void {
  resetAutoFix();
  sessionAttemptTimestamps = [];
  lastSessionEndTime = 0;
}

// ─── Error Fingerprinting & Fix Loop Detection ─────────────────────────────

/**
 * FNV-1a 32-bit hash.
 * Produces a stable hex string fingerprint for an error.
 */
function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }

  // Convert to unsigned 32-bit then to hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute a stable fingerprint for an error.
 * Uses FNV-1a hash of the error type + a normalised message (first 200 chars, trimmed).
 */
export function computeErrorFingerprint(errorType: string, errorMessage: string): string {
  const normalised = `${errorType}::${errorMessage.trim().slice(0, 200)}`;

  return fnv1aHash(normalised);
}

/**
 * Record a fingerprint occurrence and return the updated count.
 * If the count reaches FIX_LOOP_THRESHOLD, the store is automatically
 * paused and the caller is informed via the return value.
 */
export function recordFingerprint(fingerprint: string): { count: number; loopDetected: boolean } {
  const currentState = autoFixStore.get();
  const prevCount = currentState.fingerprintCounts[fingerprint] ?? 0;
  const newCount = prevCount + 1;

  const loopDetected = newCount >= FIX_LOOP_THRESHOLD;

  const updates: Partial<AutoFixState> = {
    fingerprintCounts: { ...currentState.fingerprintCounts, [fingerprint]: newCount },
  };

  if (loopDetected && !currentState.pausedByLoop) {
    updates.pausedByLoop = true;
    updates.loopFingerprint = fingerprint;
    updates.isFixing = false;
    logger.warn(`Fix loop detected for fingerprint ${fingerprint} (seen ${newCount} times). Pausing auto-fix.`);
  }

  autoFixStore.set({ ...currentState, ...updates });

  return { count: newCount, loopDetected };
}

/**
 * Check whether a given fingerprint has triggered a fix loop.
 */
export function isFixLoop(fingerprint: string): boolean {
  const state = autoFixStore.get();

  return (state.fingerprintCounts[fingerprint] ?? 0) >= FIX_LOOP_THRESHOLD;
}

/**
 * Resume auto-fix after a loop pause (user-initiated).
 * Clears the loop state and resets fingerprint counts so the user can retry.
 */
export function resumeFromLoop(): void {
  const currentState = autoFixStore.get();

  autoFixStore.set({
    ...currentState,
    pausedByLoop: false,
    loopFingerprint: null,
    fingerprintCounts: {},
  });

  logger.info('Auto-fix resumed after loop pause — fingerprint counts cleared');
}
