/**
 * Error Classifier
 *
 * Classifies errors into categories with severity levels, recovery info,
 * and user-facing suggestions. Used by terminal and preview error handlers
 * to decide whether to show a toast (non-fatal) or the full ChatAlert dialog (fatal).
 */

export type ErrorCategory = 'network' | 'auth' | 'validation' | 'build' | 'runtime' | 'unknown';
export type ErrorSeverity = 'fatal' | 'error' | 'warning' | 'info';

export interface ClassifiedError {
  category: ErrorCategory;
  severity: ErrorSeverity;
  message: string;
  originalError?: unknown;
  recoverable: boolean;
  suggestion?: string;
}

interface ClassificationRule {
  pattern: RegExp;
  category: ErrorCategory;
  severity: ErrorSeverity;
  recoverable: boolean;
  suggestion?: string;
}

/**
 * Classification rules ordered by specificity — first match wins.
 * More specific patterns come before broader ones within each category.
 */
const CLASSIFICATION_RULES: ClassificationRule[] = [
  // --- Network errors ---
  {
    pattern: /CORS.*error|blocked by CORS|Access-Control-Allow-Origin/i,
    category: 'network',
    severity: 'warning',
    recoverable: true,
    suggestion: 'The API may need to allow requests from your domain. Check CORS configuration.',
  },
  {
    pattern: /ERR_CONNECTION_REFUSED|ECONNREFUSED|connection refused/i,
    category: 'network',
    severity: 'warning',
    recoverable: true,
    suggestion: 'The server may be down or the URL is incorrect. Check the endpoint.',
  },
  {
    pattern: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT|request timed out/i,
    category: 'network',
    severity: 'error',
    recoverable: true,
    suggestion: 'The request took too long. Check your connection or try again.',
  },
  {
    pattern: /fetch.*failed|network.*error|ERR_NETWORK|ENOTFOUND|getaddrinfo/i,
    category: 'network',
    severity: 'warning',
    recoverable: true,
    suggestion: 'Check your internet connection or the API endpoint URL.',
  },

  // --- Auth errors ---
  {
    pattern: /401\s*Unauthorized|HTTP\s+401/i,
    category: 'auth',
    severity: 'error',
    recoverable: true,
    suggestion: 'Authentication required. Check your credentials or API key.',
  },
  {
    pattern: /403\s*Forbidden|HTTP\s+403/i,
    category: 'auth',
    severity: 'error',
    recoverable: true,
    suggestion: 'Access denied. You may not have permission for this resource.',
  },
  {
    pattern: /api[_ -]?key.*(?:invalid|missing|expired|required)|invalid.*api[_ -]?key/i,
    category: 'auth',
    severity: 'error',
    recoverable: true,
    suggestion: 'Your API key is invalid or missing. Check your configuration.',
  },
  {
    pattern: /token.*(?:expired|invalid|missing)|invalid.*token|unauthorized/i,
    category: 'auth',
    severity: 'error',
    recoverable: true,
    suggestion: 'Your authentication token is invalid or expired. Re-authenticate.',
  },

  // --- Validation errors ---
  {
    pattern: /ZodError|z\..*\.parse|validation.*failed|invalid.*input/i,
    category: 'validation',
    severity: 'warning',
    recoverable: true,
    suggestion: 'Input validation failed. Check the data format and required fields.',
  },
  {
    pattern: /schema.*(?:validation|error|invalid)|invalid.*schema/i,
    category: 'validation',
    severity: 'warning',
    recoverable: true,
    suggestion: 'Data does not match the expected schema. Verify the structure.',
  },

  // --- Build errors (specific before generic) ---
  {
    pattern: /error TS\d+:/i,
    category: 'build',
    severity: 'fatal',
    recoverable: false,
    suggestion: 'Fix the TypeScript type errors before the project can build.',
  },
  {
    pattern: /\[vite\]\s*(?:Internal server error|Error)/i,
    category: 'build',
    severity: 'fatal',
    recoverable: false,
    suggestion: 'Vite encountered a build error. Check the file referenced in the error.',
  },
  {
    pattern: /\[plugin:vite:css\].*\[postcss\]/i,
    category: 'build',
    severity: 'error',
    recoverable: false,
    suggestion: 'PostCSS encountered an error processing your CSS. Check syntax.',
  },
  {
    pattern: /PostCSS.*(?:warning|warn)/i,
    category: 'build',
    severity: 'warning',
    recoverable: true,
    suggestion: 'PostCSS emitted a warning. This may not break the build but should be reviewed.',
  },
  {
    pattern: /Module not found|Cannot find module|Failed to resolve import|ERR_MODULE_NOT_FOUND/i,
    category: 'build',
    severity: 'fatal',
    recoverable: false,
    suggestion: 'A required module is missing. Check the import path or install the dependency.',
  },
  {
    pattern: /does not provide an export named/i,
    category: 'build',
    severity: 'fatal',
    recoverable: false,
    suggestion: 'The import name does not match the module exports. Check named vs default exports.',
  },
  {
    pattern: /Build failed|error during build|Failed to scan for dependencies/i,
    category: 'build',
    severity: 'fatal',
    recoverable: false,
    suggestion: 'The build process failed. Check the detailed error output.',
  },
  {
    pattern: /SyntaxError|Unexpected token|CssSyntaxError/i,
    category: 'build',
    severity: 'fatal',
    recoverable: false,
    suggestion: 'There is a syntax error in the code. Check for missing brackets or typos.',
  },

  // --- Runtime errors ---
  {
    pattern: /Cannot read propert(?:y|ies) of (?:undefined|null)/i,
    category: 'runtime',
    severity: 'error',
    recoverable: true,
    suggestion: 'A property was accessed on null/undefined. Add a null check or optional chaining (?.).',
  },
  {
    pattern: /Maximum call stack size exceeded|stack overflow/i,
    category: 'runtime',
    severity: 'fatal',
    recoverable: false,
    suggestion: 'Infinite recursion detected. Check for recursive function calls without a base case.',
  },
  {
    pattern: /Maximum update depth exceeded/i,
    category: 'runtime',
    severity: 'fatal',
    recoverable: false,
    suggestion: 'Infinite re-render loop. Check useEffect dependencies and state updates.',
  },
  {
    pattern: /TypeError/i,
    category: 'runtime',
    severity: 'error',
    recoverable: true,
    suggestion: 'A value was used in an unexpected way. Verify variable types.',
  },
  {
    pattern: /ReferenceError/i,
    category: 'runtime',
    severity: 'error',
    recoverable: true,
    suggestion: 'A variable is used before being defined. Check variable declarations.',
  },
  {
    pattern: /RangeError/i,
    category: 'runtime',
    severity: 'error',
    recoverable: true,
    suggestion: 'A value is outside its allowed range. Check array indices and numeric operations.',
  },

  // --- System / process errors ---
  {
    pattern: /EADDRINUSE/i,
    category: 'build',
    severity: 'error',
    recoverable: true,
    suggestion: 'Port is already in use. Close the other process or use a different port.',
  },
  {
    pattern: /EACCES/i,
    category: 'build',
    severity: 'error',
    recoverable: true,
    suggestion: 'Permission denied. Check file permissions.',
  },
  {
    pattern: /ENOMEM|heap out of memory|JavaScript heap/i,
    category: 'runtime',
    severity: 'fatal',
    recoverable: false,
    suggestion: 'Out of memory. Try closing other applications.',
  },
  {
    pattern: /SIGKILL|SIGTERM/i,
    category: 'runtime',
    severity: 'error',
    recoverable: true,
    suggestion: 'Process was terminated. Try running again.',
  },
  {
    pattern: /EPERM|operation not permitted/i,
    category: 'build',
    severity: 'error',
    recoverable: true,
    suggestion: 'Operation not permitted. Check file permissions.',
  },
  {
    pattern: /Circular dependency/i,
    category: 'build',
    severity: 'warning',
    recoverable: true,
    suggestion: 'Circular dependency detected. This may cause issues.',
  },
];

/**
 * Extract a concise message from an error of any shape.
 */
function extractMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }

  return String(error);
}

/**
 * Classify an error into a category with severity and recovery information.
 *
 * The classifier walks through ordered rules and returns the first match.
 * Errors that match no rule are classified as `unknown / error`.
 */
export function classifyError(error: unknown): ClassifiedError {
  const message = extractMessage(error);

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(message)) {
      return {
        category: rule.category,
        severity: rule.severity,
        message,
        originalError: error,
        recoverable: rule.recoverable,
        suggestion: rule.suggestion,
      };
    }
  }

  return {
    category: 'unknown',
    severity: 'error',
    message,
    originalError: error,
    recoverable: false,
  };
}

/**
 * Determine whether a classified error should trigger a full alert dialog
 * (ChatAlert) or a lightweight toast notification.
 *
 * Fatal and error-severity errors get the full dialog so the user can
 * ask Bolt for help. Warnings and info-level issues get a toast.
 */
export function shouldShowFullAlert(classified: ClassifiedError): boolean {
  return classified.severity === 'fatal' || classified.severity === 'error';
}
