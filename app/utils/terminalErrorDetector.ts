/**
 * Terminal Error Detector
 *
 * Detects actionable errors in terminal output and triggers alerts
 * so users can easily send errors to Bolt for fixing.
 */

import { workbenchStore } from '~/lib/stores/workbench';
import { createScopedLogger } from '~/utils/logger';
import { classifyError, shouldShowFullAlert } from '~/lib/errors/error-classifier';
import { showErrorToast } from '~/lib/errors/error-toast';

const logger = createScopedLogger('TerminalErrorDetector');

/**
 * Error pattern definition
 */
export interface ErrorPattern {
  /** Regex pattern to match */
  pattern: RegExp;

  /** Type of error for categorization */
  type: 'build' | 'runtime' | 'package' | 'syntax' | 'module';

  /** Error severity */
  severity: 'error' | 'warning';

  /** Human-readable title for the alert */
  title: string;

  /** Whether this error type can be auto-fixed by the LLM */
  autoFixable?: boolean;

  /** Optional function to extract details from the match */
  extractDetails?: (match: RegExpMatchArray, fullOutput: string) => string;
}

/**
 * Detected error structure
 */
export interface DetectedError {
  type: ErrorPattern['type'];
  severity: ErrorPattern['severity'];
  title: string;
  message: string;
  details: string;
  timestamp: number;
  hash: string;

  /** Whether this error can be auto-fixed */
  autoFixable: boolean;
}

/**
 * Error patterns to detect in terminal output
 * Ordered by specificity - more specific patterns first
 * autoFixable: true for errors the LLM can likely fix (code issues)
 * autoFixable: false for errors requiring user action (ports, permissions, network)
 */
const ERROR_PATTERNS: ErrorPattern[] = [
  // Module export errors (specific - check first)
  {
    pattern: /does not provide an export named ["'](.+?)["']/i,
    type: 'module',
    severity: 'error',
    title: 'Invalid Export',
    autoFixable: true,
    extractDetails: (match, fullOutput) => {
      // Get context around the error
      const errorIdx = fullOutput.indexOf(match[0]);
      const contextEnd = Math.min(fullOutput.length, errorIdx + 500);

      return `Export "${match[1]}" does not exist. ${fullOutput.slice(Math.max(0, errorIdx - 100), contextEnd).trim()}`;
    },
  },

  // HMR failed to reload with underlying error (self-recovers on next save — don't auto-fix)
  {
    pattern: /\[hmr\]\s*(?:Failed to reload|failed).*?\/(.+?)(?:\.|$)/i,
    type: 'build',
    severity: 'error',
    title: 'HMR Reload Failed',
    autoFixable: false,
    extractDetails: (match, fullOutput) => {
      // Check if there's a SyntaxError or other real error nearby
      const errorIdx = fullOutput.indexOf(match[0]);
      const contextStart = Math.max(0, errorIdx - 300);
      const contextEnd = Math.min(fullOutput.length, errorIdx + 500);
      const context = fullOutput.slice(contextStart, contextEnd);

      // If there's a SyntaxError, include it
      const syntaxMatch = context.match(/SyntaxError[:\s]+(.+?)(?:\n|$)/i);

      if (syntaxMatch) {
        return `HMR failed for ${match[1]}: ${syntaxMatch[1]}`;
      }

      return `HMR failed to reload ${match[1]}. Check for syntax or import errors.`;
    },
  },

  // esbuild errors (X ERROR format)
  {
    pattern: /X\s+ERROR\s+(.+?)(?:\n|$)/i,
    type: 'build',
    severity: 'error',
    title: 'Build Error',
    autoFixable: true,
    extractDetails: (match, fullOutput) => {
      // Get more context for esbuild errors (includes file path and suggestion)
      const errorIdx = fullOutput.indexOf(match[0]);
      const contextEnd = Math.min(fullOutput.length, errorIdx + 800);

      return fullOutput.slice(errorIdx, contextEnd).trim();
    },
  },

  // JSX syntax errors
  {
    pattern: /The character "(.+?)" is not valid inside a JSX element/i,
    type: 'syntax',
    severity: 'error',
    title: 'JSX Syntax Error',
    autoFixable: true,
    extractDetails: (match, fullOutput) => {
      const errorIdx = fullOutput.indexOf(match[0]);
      const contextEnd = Math.min(fullOutput.length, errorIdx + 600);

      return fullOutput.slice(Math.max(0, errorIdx - 50), contextEnd).trim();
    },
  },

  // Vite specific errors
  {
    pattern: /\[vite\]\s*(?:Internal server error|Error):\s*(.+?)(?:\n|$)/i,
    type: 'build',
    severity: 'error',
    title: 'Vite Build Error',
    autoFixable: true,
    extractDetails: (match, fullOutput) => {
      // Try to extract more context around the error
      const errorIdx = fullOutput.indexOf(match[0]);
      const contextStart = Math.max(0, errorIdx - 100);
      const contextEnd = Math.min(fullOutput.length, errorIdx + match[0].length + 500);

      return fullOutput.slice(contextStart, contextEnd).trim();
    },
  },

  // Vite CSS/PostCSS plugin errors
  {
    pattern: /\[plugin:vite:css\].*?\[postcss\]\s*(.+?)(?:\n|$)/i,
    type: 'build',
    severity: 'error',
    title: 'CSS/PostCSS Error',
    autoFixable: true,
    extractDetails: (match, fullOutput) => {
      const errorIdx = fullOutput.indexOf(match[0]);
      const contextEnd = Math.min(fullOutput.length, errorIdx + 800);

      return fullOutput.slice(errorIdx, contextEnd).trim();
    },
  },
  {
    pattern: /\[plugin:vite:[^\]]+\]\s*(.+?)(?:\n|$)/i,
    type: 'build',
    severity: 'error',
    title: 'Vite Plugin Error',
    autoFixable: true,
    extractDetails: (match, fullOutput) => {
      const errorIdx = fullOutput.indexOf(match[0]);
      const contextEnd = Math.min(fullOutput.length, errorIdx + 600);

      return fullOutput.slice(errorIdx, contextEnd).trim();
    },
  },

  // Tailwind CSS errors
  {
    pattern: /The [`'](.+?)[`']\s*class does not exist/i,
    type: 'build',
    severity: 'error',
    title: 'Tailwind CSS Error',
    autoFixable: true,
    extractDetails: (match) =>
      `The class "${match[1]}" does not exist. Make sure it is defined in your Tailwind config or use a valid utility class.`,
  },
  {
    pattern: /CssSyntaxError:\s*(.+?)(?:\n|$)/i,
    type: 'syntax',
    severity: 'error',
    title: 'CSS Syntax Error',
    autoFixable: true,
  },
  {
    pattern: /Failed to resolve import ["'](.+?)["'].*?from ["'](.+?)["']/i,
    type: 'module',
    severity: 'error',
    title: 'Import Resolution Failed',
    autoFixable: true,
    extractDetails: (match) => `Cannot resolve import "${match[1]}" from "${match[2]}"`,
  },
  {
    pattern: /Module not found:\s*(?:Error:\s*)?(?:Can't resolve\s*)?["']?(.+?)["']?(?:\s+in\s+["']?(.+?)["']?)?/i,
    type: 'module',
    severity: 'error',
    title: 'Module Not Found',
    autoFixable: true,
  },
  {
    pattern: /Cannot find module ["'](.+?)["']/i,
    type: 'module',
    severity: 'error',
    title: 'Module Not Found',
    autoFixable: true,
    extractDetails: (match) => `Cannot find module "${match[1]}"`,
  },

  // TypeScript errors
  {
    pattern: /error TS(\d+):\s*(.+?)(?:\n|$)/i,
    type: 'syntax',
    severity: 'error',
    title: 'TypeScript Error',
    autoFixable: true,
    extractDetails: (match) => `TS${match[1]}: ${match[2]}`,
  },
  {
    pattern: /Type\s+["'](.+?)["']\s+is not assignable to type\s+["'](.+?)["']/i,
    type: 'syntax',
    severity: 'error',
    title: 'TypeScript Type Error',
    autoFixable: true,
  },

  // JavaScript runtime errors
  {
    pattern: /SyntaxError:\s*(.+?)(?:\n|$)/i,
    type: 'syntax',
    severity: 'error',
    title: 'Syntax Error',
    autoFixable: true,
    extractDetails: (match) => match[1],
  },
  {
    pattern: /TypeError:\s*(.+?)(?:\n|$)/i,
    type: 'runtime',
    severity: 'error',
    title: 'Type Error',
    autoFixable: true,
    extractDetails: (match) => match[1],
  },
  {
    pattern: /ReferenceError:\s*(.+?)(?:\n|$)/i,
    type: 'runtime',
    severity: 'error',
    title: 'Reference Error',
    autoFixable: true,
    extractDetails: (match) => match[1],
  },

  // Package manager errors
  {
    pattern: /npm ERR!\s*(.+?)(?:\n|$)/i,
    type: 'package',
    severity: 'error',
    title: 'npm Error',
    autoFixable: true, // Often missing dependencies that can be added
    extractDetails: (_match, fullOutput) => {
      // Get more npm error context
      const lines = fullOutput.split('\n');
      const errorLines = lines.filter((line) => line.includes('npm ERR!'));

      return errorLines.slice(0, 10).join('\n');
    },
  },
  {
    pattern: /pnpm ERR!\s*(.+?)(?:\n|$)/i,
    type: 'package',
    severity: 'error',
    title: 'pnpm Error',
    autoFixable: true,
  },
  {
    pattern: /ENOENT:\s*no such file or directory[,\s]*(?:open\s*)?["']?(.+?)["']?/i,
    type: 'build',
    severity: 'error',
    title: 'File Not Found',
    autoFixable: true,
    extractDetails: (match) => `File not found: ${match[1]}`,
  },

  // ESLint errors (but not warnings)
  {
    pattern: /✖\s*(\d+)\s+(?:error|problem)s?/i,
    type: 'syntax',
    severity: 'error',
    title: 'ESLint Errors',
    autoFixable: true,
    extractDetails: (match) => `${match[1]} ESLint error(s) found`,
  },

  // General build failures
  {
    pattern: /Build failed with (\d+) errors?/i,
    type: 'build',
    severity: 'error',
    title: 'Build Failed',
    autoFixable: true,
    extractDetails: (match) => `Build failed with ${match[1]} error(s)`,
  },
  {
    pattern: /error\s+during\s+build/i,
    type: 'build',
    severity: 'error',
    title: 'Build Error',
    autoFixable: true,
  },
  {
    pattern: /Failed to scan for dependencies/i,
    type: 'build',
    severity: 'error',
    title: 'Dependency Scan Failed',
    autoFixable: true,
    extractDetails: (_match, fullOutput) => {
      // Get context around the error
      const errorIdx = fullOutput.indexOf('Failed to scan');
      const contextEnd = Math.min(fullOutput.length, errorIdx + 300);

      return fullOutput.slice(Math.max(0, errorIdx - 50), contextEnd).trim();
    },
  },

  // Cannot use import statement outside a module (ESM/CJS mismatch)
  {
    pattern: /Cannot use import statement outside a module/i,
    type: 'syntax',
    severity: 'error',
    title: 'ESM/CJS Mismatch',
    autoFixable: true,
    extractDetails: (_match, fullOutput) => {
      const errorIdx = fullOutput.indexOf('Cannot use import');
      const contextEnd = Math.min(fullOutput.length, errorIdx + 400);

      return fullOutput.slice(Math.max(0, errorIdx - 100), contextEnd).trim();
    },
  },

  // Node ESM module not found (ERR_MODULE_NOT_FOUND)
  {
    pattern: /ERR_MODULE_NOT_FOUND.*?['"]([^'"]+)['"]/i,
    type: 'module',
    severity: 'error',
    title: 'ESM Module Not Found',
    autoFixable: true,
    extractDetails: (match) => `ESM module not found: ${match[1]}`,
  },

  // Invariant Violation (React, libraries)
  {
    pattern: /Invariant Violation:\s*(.+?)(?:\n|$)/i,
    type: 'runtime',
    severity: 'error',
    title: 'Invariant Violation',
    autoFixable: true,
    extractDetails: (match) => match[1],
  },

  // Dynamic import / chunk load failure
  {
    pattern: /ChunkLoadError|Loading chunk \d+ failed|Failed to fetch dynamically imported module/i,
    type: 'build',
    severity: 'error',
    title: 'Dynamic Import Failed',
    autoFixable: true,
    extractDetails: (_match, fullOutput) => {
      const errorIdx = fullOutput.search(/ChunkLoadError|Loading chunk|dynamically imported/i);
      const contextEnd = Math.min(fullOutput.length, errorIdx + 400);

      return fullOutput.slice(Math.max(0, errorIdx - 50), contextEnd).trim();
    },
  },

  // Vite pre-transform error
  {
    pattern: /Pre-transform error:\s*(.+?)(?:\n|$)/i,
    type: 'build',
    severity: 'error',
    title: 'Vite Pre-transform Error',
    autoFixable: true,
    extractDetails: (match, fullOutput) => {
      const errorIdx = fullOutput.indexOf(match[0]);
      const contextEnd = Math.min(fullOutput.length, errorIdx + 500);

      return fullOutput.slice(errorIdx, contextEnd).trim();
    },
  },

  // Objects are not valid as a React child (sometimes shows in terminal SSR)
  {
    pattern: /Objects are not valid as a React child/i,
    type: 'runtime',
    severity: 'error',
    title: 'Invalid React Child',
    autoFixable: true,
    extractDetails: (_match, fullOutput) => {
      const errorIdx = fullOutput.indexOf('Objects are not valid');
      const contextEnd = Math.min(fullOutput.length, errorIdx + 500);

      return fullOutput.slice(Math.max(0, errorIdx - 50), contextEnd).trim();
    },
  },

  // Maximum update depth exceeded (sometimes shows in terminal SSR)
  {
    pattern: /Maximum update depth exceeded/i,
    type: 'runtime',
    severity: 'error',
    title: 'Infinite Re-render Loop',
    autoFixable: true,
  },

  // Invalid hook call
  {
    pattern: /Invalid hook call/i,
    type: 'runtime',
    severity: 'error',
    title: 'Invalid Hook Call',
    autoFixable: true,
    extractDetails: (_match, fullOutput) => {
      const errorIdx = fullOutput.indexOf('Invalid hook call');
      const contextEnd = Math.min(fullOutput.length, errorIdx + 600);

      return fullOutput.slice(Math.max(0, errorIdx - 50), contextEnd).trim();
    },
  },

  // Element type is invalid (sometimes shows in terminal SSR)
  {
    pattern: /Element type is invalid.*?expected a string.*?but got/i,
    type: 'runtime',
    severity: 'error',
    title: 'Invalid Component Type',
    autoFixable: true,
    extractDetails: (_match, fullOutput) => {
      const errorIdx = fullOutput.indexOf('Element type is invalid');
      const contextEnd = Math.min(fullOutput.length, errorIdx + 500);

      return fullOutput.slice(Math.max(0, errorIdx - 50), contextEnd).trim();
    },
  },

  /*
   * Port in use - NOT auto-fixable and NOT alertable
   * Dev servers (Vite, Next.js, etc.) auto-retry on the next available port,
   * so this is almost always a false positive that confuses users.
   * Removed from active detection — kept as comment for reference.
   * {
   *   pattern: /Port\s+(\d+)\s+is\s+(?:already\s+)?in\s+use/i,
   *   type: 'runtime',
   *   severity: 'error',
   *   title: 'Port In Use',
   *   autoFixable: false,
   * },
   */
];

/**
 * Patterns to ignore (false positives)
 */
const IGNORE_PATTERNS: RegExp[] = [
  // Ignore internal shell markers used for command completion detection
  /__BOLT_CMD_DONE__/i,

  // Ignore deprecation warnings
  /deprecat(?:ed|ion)/i,

  // Ignore peer dependency warnings
  /peer\s+dep/i,

  // Ignore warnings about optional dependencies
  /optional\s+dependency/i,

  // Ignore info/debug messages that look like errors
  /\[INFO\]/i,
  /\[DEBUG\]/i,

  // Ignore successful messages
  /successfully/i,
  /completed/i,

  // Ignore Ctrl+C signals (^C) — these appear when runtime teardown sends SIGINT
  /^\^?C$/,
];

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
 * Terminal Error Detector class
 * Handles buffering, debouncing, and deduplication of errors
 */
export class TerminalErrorDetector {
  #buffer: string = '';
  #detectedErrors: DetectedError[] = [];
  #lastAlertTime: number = 0;
  #recentErrorHashes: Map<string, number> = new Map();
  #debounceTimer: NodeJS.Timeout | null = null;
  #isEnabled: boolean = true;
  #cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  // Configuration constants
  #DEBOUNCE_MS = 500;
  #COOLDOWN_MS = 3000;
  #MAX_BUFFER_SIZE = 10000;
  #HASH_TTL_MS = 30000;

  constructor() {
    // Clean up old hashes periodically - store interval ID for cleanup
    this.#cleanupIntervalId = setInterval(() => this.#cleanupOldHashes(), this.#HASH_TTL_MS);
  }

  /**
   * Cleanup resources when detector is no longer needed
   * Call this method to prevent memory leaks
   */
  destroy(): void {
    if (this.#cleanupIntervalId) {
      clearInterval(this.#cleanupIntervalId);
      this.#cleanupIntervalId = null;
    }

    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }

    this.#buffer = '';
    this.#detectedErrors = [];
    this.#recentErrorHashes.clear();
    logger.debug('TerminalErrorDetector destroyed');
  }

  /**
   * Enable/disable error detection
   */
  setEnabled(enabled: boolean): void {
    this.#isEnabled = enabled;
    logger.debug(`Error detection ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Process terminal output chunk
   * This should be called with each chunk of terminal output
   */
  processOutput(data: string): void {
    if (!this.#isEnabled) {
      return;
    }

    // Add to buffer
    this.#buffer += data;

    // Trim buffer if too large
    if (this.#buffer.length > this.#MAX_BUFFER_SIZE) {
      this.#buffer = this.#buffer.slice(-this.#MAX_BUFFER_SIZE / 2);
    }

    // Check for errors with debouncing
    this.#scheduleErrorCheck();
  }

  #scheduleErrorCheck(): void {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }

    this.#debounceTimer = setTimeout(() => {
      this.#checkForErrors();
    }, this.#DEBOUNCE_MS);
  }

  #checkForErrors(): void {
    // Clean buffer of ANSI escape codes for pattern matching
    const cleanBuffer = this.#stripAnsi(this.#buffer);

    const newErrors: DetectedError[] = [];

    for (const pattern of ERROR_PATTERNS) {
      const match = cleanBuffer.match(pattern.pattern);

      if (match) {
        const errorMessage = match[1] || match[0];

        // Skip errors that match an ignore pattern (deprecation warnings, peer dep warnings, etc.)
        if (IGNORE_PATTERNS.some((ip) => ip.test(errorMessage))) {
          continue;
        }

        // Skip absurdly short error messages (likely ANSI artifacts or Ctrl+C remnants)
        if (errorMessage.trim().length < 3) {
          continue;
        }

        const details = pattern.extractDetails ? pattern.extractDetails(match, cleanBuffer) : match[0];

        const errorHash = hashError(errorMessage + pattern.title);

        // Skip if we've recently shown this error
        if (this.#recentErrorHashes.has(errorHash)) {
          continue;
        }

        const error: DetectedError = {
          type: pattern.type,
          severity: pattern.severity,
          title: pattern.title,
          message: errorMessage,
          details,
          timestamp: Date.now(),
          hash: errorHash,
          autoFixable: pattern.autoFixable ?? false, // Default to false — only explicitly marked patterns trigger auto-fix
        };

        newErrors.push(error);
        this.#recentErrorHashes.set(errorHash, Date.now());
      }
    }

    if (newErrors.length > 0) {
      this.#detectedErrors.push(...newErrors);
      this.#triggerAlert();
    }

    // Clear buffer after processing
    this.#buffer = '';
  }

  #triggerAlert(): void {
    const now = Date.now();

    if (now - this.#lastAlertTime < this.#COOLDOWN_MS) {
      logger.debug('Skipping alert due to cooldown');

      return;
    }

    if (this.#detectedErrors.length === 0) {
      return;
    }

    this.#lastAlertTime = now;

    // Get the most recent/important error
    const primaryError = this.#detectedErrors[this.#detectedErrors.length - 1];

    // Classify the error to decide alert vs toast
    const classified = classifyError(primaryError.message);

    if (shouldShowFullAlert(classified)) {
      // Fatal / error severity → full ChatAlert dialog so user can ask Bolt for help
      const content = this.#formatErrorContent();

      workbenchStore.actionAlert.set({
        type: 'error',
        title: primaryError.title,
        description: primaryError.message,
        content,
        source: 'terminal',
      });

      logger.info(`Terminal error [${classified.severity}/${classified.category}]: ${primaryError.title}`);
    } else {
      // Warning / info severity → lightweight toast notification
      showErrorToast({
        ...classified,
        message: `${primaryError.title}: ${primaryError.message}`,
      });

      logger.info(`Terminal warning toast [${classified.category}]: ${primaryError.title}`);
    }

    // Clear processed errors
    this.#detectedErrors = [];
  }

  #formatErrorContent(): string {
    if (this.#detectedErrors.length === 1) {
      const error = this.#detectedErrors[0];

      /*
       * For module/import errors, add instruction to fix ALL similar issues at once.
       * This prevents sequential auto-fix loops where each restart reveals one more missing dep.
       */
      if (error.type === 'module') {
        return (
          error.details +
          '\n\nIMPORTANT: This is likely one of MULTIPLE missing dependencies. ' +
          'Before fixing, scan ALL .tsx and .ts files for import statements and verify EVERY ' +
          'imported package exists in package.json dependencies. Fix ALL missing packages in a ' +
          'single package.json update, then run npm install once. Do NOT fix just this one package — ' +
          'check for @radix-ui/*, class-variance-authority, clsx, tailwind-merge, lucide-react, ' +
          'and any other imported packages that may be missing.'
        );
      }

      /*
       * For runtime errors, add instruction to check the full component tree.
       * The error may cascade from a parent component passing wrong props.
       */
      if (error.type === 'runtime') {
        return (
          error.details +
          '\n\nIMPORTANT: Check the FULL component tree, not just the file mentioned in the error. ' +
          'Runtime errors often originate from a parent passing wrong data/props. ' +
          'Trace the data flow from the source (API call, state initialization) to where it crashes.'
        );
      }

      return error.details;
    }

    // Multiple errors - format as list
    const lines: string[] = [];
    lines.push(`Found ${this.#detectedErrors.length} error(s):\n`);

    for (const error of this.#detectedErrors.slice(0, 5)) {
      // Limit to 5 errors
      lines.push(`• ${error.title}: ${error.message}`);
    }

    if (this.#detectedErrors.length > 5) {
      lines.push(`\n... and ${this.#detectedErrors.length - 5} more error(s)`);
    }

    lines.push('\n\n--- Details ---\n');
    lines.push(this.#detectedErrors[0].details);

    /*
     * If any module errors present, add batch-fix instruction
     */
    const hasModuleErrors = this.#detectedErrors.some((e) => e.type === 'module');

    if (hasModuleErrors) {
      lines.push(
        '\n\nIMPORTANT: Scan ALL .tsx and .ts files for import statements and verify EVERY ' +
          'imported package exists in package.json. Fix ALL missing packages in a single update.',
      );
    }

    return lines.join('\n');
  }

  #stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  }

  #cleanupOldHashes(): void {
    const now = Date.now();

    for (const [hash, timestamp] of this.#recentErrorHashes) {
      if (now - timestamp > 60_000) {
        this.#recentErrorHashes.delete(hash);
      }
    }
  }

  /**
   * Clear all state (useful for testing or reset)
   */
  reset(): void {
    this.#buffer = '';
    this.#detectedErrors = [];
    this.#recentErrorHashes.clear();

    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
  }

  /**
   * Manually dismiss current alert
   */
  dismissAlert(): void {
    workbenchStore.clearAlert();
  }
}

// Singleton instance
let detectorInstance: TerminalErrorDetector | null = null;

/**
 * Get the singleton error detector instance
 */
export function getTerminalErrorDetector(): TerminalErrorDetector {
  if (!detectorInstance) {
    detectorInstance = new TerminalErrorDetector();
  }

  return detectorInstance;
}

/**
 * Convenience function to process terminal output
 */
export function detectTerminalErrors(data: string): void {
  getTerminalErrorDetector().processOutput(data);
}

/**
 * Reset the error detector state
 * Call this when user requests a fix so the same error can be detected again
 */
export function resetTerminalErrorDetector(): void {
  getTerminalErrorDetector().reset();
}
