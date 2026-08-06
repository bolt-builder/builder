/**
 * Error Configuration
 *
 * Centralized configuration for error handling across the application.
 * This provides a single source of truth for error patterns, severity levels,
 * suppression rules, and user-friendly messages.
 *
 * @module errorConfig
 */

import type { ErrorSeverity, ErrorCategory } from '~/types/errors';

/**
 * Patterns that should be suppressed (not shown to users).
 * These are non-actionable errors that would only confuse users.
 */
export const SUPPRESSION_PATTERNS: Array<{
  /** Pattern to match against error message */
  pattern: RegExp;

  /** Reason for suppression (for debugging) */
  reason: string;

  /** Error categories this applies to */
  categories: ErrorCategory[];
}> = [
  // Inspector / DevTools internal errors - not user code issues
  {
    pattern: /_bolt-inspector|_bolt-capture|_bolt-html2canvas|inspector-core|screenshot-capture|error-capture\.js/i,
    reason: 'Internal inspector tooling errors should not trigger AutoFix',
    categories: ['preview'],
  },

  // Source map errors - not actionable by users
  {
    pattern: /source\s*map.*404|\.map\s+404|failed.*source\s*map/i,
    reason: 'Source map loading failures are development-only and non-actionable',
    categories: ['preview', 'network'],
  },
  {
    pattern: /Failed to load resource:.*\.map$/i,
    reason: 'Source map files missing is a non-critical issue',
    categories: ['preview', 'network'],
  },

  // 3D/Graphics library buffer errors (Spline, Three.js, etc.)
  {
    pattern: /Data read,?\s*but end of buffer not reached/i,
    reason: 'Spline/3D library internal parsing - usually self-recovers',
    categories: ['preview'],
  },
  {
    pattern: /splinetool.*buffer|three\.?js.*buffer/i,
    reason: 'Known 3D library buffer handling issue',
    categories: ['preview'],
  },
  {
    pattern: /prod\.spline\.design.*403|spline.*forbidden/i,
    reason: 'Spline CDN blocked — expected behavior',
    categories: ['preview', 'network'],
  },
  {
    pattern: /@splinetool\/.*error|splinetool.*failed/i,
    reason: 'Spline library loading issue — expected behavior',
    categories: ['preview'],
  },
  {
    pattern: /Invalid URI\. Load of media resource.*failed/i,
    reason: 'Media resource loading failure - common with 3D assets',
    categories: ['preview', 'network'],
  },

  // Hot Module Replacement noise
  {
    pattern: /\[hmr\].*failed|hmr.*update.*failed/i,
    reason: 'HMR failures auto-recover on next save',
    categories: ['preview', 'terminal'],
  },
  {
    pattern: /\[vite\].*hmr.*invalidate/i,
    reason: 'HMR invalidation is normal development behavior',
    categories: ['preview'],
  },

  // WebSocket connection issues (normal during dev)
  {
    pattern: /websocket.*connection.*closed|ws:\/\/.*failed/i,
    reason: 'WebSocket reconnection is automatic',
    categories: ['preview', 'network'],
  },

  // Browser extension interference
  {
    pattern: /chrome-extension:\/\/|moz-extension:\/\//i,
    reason: 'Browser extension errors are not from user code',
    categories: ['preview'],
  },

  // React strict mode double-rendering warnings
  {
    pattern: /React\.StrictMode|strictMode.*double/i,
    reason: 'Strict mode behavior is intentional and informational',
    categories: ['preview'],
  },

  // Development-only console messages
  {
    pattern: /Download the React DevTools|React does not recognize the/i,
    reason: 'Development hints, not errors',
    categories: ['preview'],
  },

  // Font loading (non-critical)
  {
    pattern: /Failed to decode downloaded font|OTS parsing error/i,
    reason: 'Font loading failures have fallbacks',
    categories: ['preview', 'network'],
  },

  // Favicon missing (extremely common, non-critical)
  {
    pattern: /favicon\.ico.*404|Failed to load.*favicon/i,
    reason: 'Missing favicon is non-critical',
    categories: ['preview', 'network'],
  },

  /* React hydration mismatches (common in dev, page still renders) */
  {
    pattern: /Text content does not match server-rendered HTML/i,
    reason: 'Hydration mismatches self-recover; page renders correctly',
    categories: ['preview'],
  },
  {
    pattern: /Hydration failed because.*initial UI.*does not match/i,
    reason: 'Hydration mismatch — React recovers and renders correctly',
    categories: ['preview'],
  },
  {
    pattern: /There was an error while hydrating/i,
    reason: 'Hydration error — React falls back to client rendering',
    categories: ['preview'],
  },
  {
    pattern: /InvariantError.*workUnitAsyncStorage/i,
    reason: 'Next.js 15+ async storage issue — page may still render',
    categories: ['preview'],
  },

  /* Tailwind CSS config TypeScript import (non-critical) */
  {
    pattern: /import type.*from ['"]tailwindcss['"]/i,
    reason: 'Tailwind config TS import logged to console — page renders correctly',
    categories: ['preview', 'terminal'],
  },

  /* Extra attribute hydration warnings */
  {
    pattern: /extra attributes from the server/i,
    reason: 'Server may add extra attributes — page renders correctly',
    categories: ['preview'],
  },
];

/**
 * User-friendly messages for common error patterns.
 * Maps technical errors to understandable explanations.
 */
export const USER_FRIENDLY_MESSAGES: Array<{
  /** Pattern to match against error message */
  pattern: RegExp;

  /** User-friendly title */
  title: string;

  /** User-friendly description */
  description: string;

  /** Suggested action */
  suggestion?: string;

  /** Severity level */
  severity: ErrorSeverity;
}> = [
  // Module/Import errors
  {
    pattern: /Cannot find module ['"](.+?)['"]/i,
    title: 'Missing Dependency',
    description: 'A required package is not installed.',
    suggestion: 'Try running "npm install" or check if the package name is correct.',
    severity: 'critical',
  },
  {
    pattern: /Failed to resolve import ['"](.+?)['"]/i,
    title: 'Import Not Found',
    description: 'Unable to find the imported file or module.',
    suggestion: 'Check the import path and ensure the file exists.',
    severity: 'critical',
  },
  {
    pattern: /Module not found/i,
    title: 'Module Not Found',
    description: 'A module could not be located.',
    suggestion: 'Verify the module is installed and the import path is correct.',
    severity: 'critical',
  },

  // Syntax errors
  {
    pattern: /SyntaxError:\s*(.+)/i,
    title: 'Syntax Error',
    description: 'There is a syntax mistake in the code.',
    suggestion: 'Check for missing brackets, quotes, or typos.',
    severity: 'critical',
  },
  {
    pattern: /Unexpected token/i,
    title: 'Unexpected Token',
    description: 'The code contains an unexpected character or symbol.',
    suggestion: 'Look for misplaced punctuation or incomplete statements.',
    severity: 'critical',
  },

  // TypeScript errors
  {
    pattern: /error TS\d+:/i,
    title: 'TypeScript Error',
    description: 'TypeScript found a type-related issue.',
    suggestion: 'Review the type annotations and ensure they match.',
    severity: 'critical',
  },
  {
    pattern: /Type ['"](.+?)['"] is not assignable/i,
    title: 'Type Mismatch',
    description: 'The types do not match what is expected.',
    suggestion: 'Check if you are using the correct type.',
    severity: 'warning',
  },

  // React/JSX errors
  {
    pattern: /Element type is invalid.*expected a string.*but got:?\s*(?:undefined|object|null)/i,
    title: 'Invalid Component',
    description: 'A component is undefined — likely a missing or incorrect export/import.',
    suggestion:
      'Check that the component is exported from its file and imported with the correct name (default vs named).',
    severity: 'critical',
  },
  {
    pattern: /Objects are not valid as a React child/i,
    title: 'Invalid React Child',
    description: 'An object was rendered where text or a component was expected.',
    suggestion: 'Ensure you are rendering a string, number, or JSX element — not a raw object or array.',
    severity: 'critical',
  },
  {
    pattern: /Maximum update depth exceeded/i,
    title: 'Infinite Re-render Loop',
    description: 'A component is updating itself in an infinite loop.',
    suggestion:
      'Check for state updates inside useEffect without proper dependencies, or event handlers that trigger re-renders.',
    severity: 'critical',
  },
  {
    pattern: /Invalid hook call/i,
    title: 'Invalid Hook Call',
    description: 'React hooks are being used incorrectly.',
    suggestion: 'Hooks must be called at the top level of a function component.',
    severity: 'critical',
  },
  {
    pattern: /must be used within/i,
    title: 'Missing Context Provider',
    description: 'A hook or component requires a parent context provider that is missing.',
    suggestion: 'Wrap the component tree with the required provider (e.g., <ChartContainer>, <ThemeProvider>).',
    severity: 'critical',
  },
  {
    pattern: /not valid inside a JSX element/i,
    title: 'JSX Syntax Error',
    description: 'Invalid character found in JSX.',
    suggestion: 'Check for unescaped characters like < or > in text.',
    severity: 'critical',
  },

  // Network errors
  {
    pattern: /fetch.*failed|network.*error|ERR_NETWORK/i,
    title: 'Network Error',
    description: 'Unable to connect to the network.',
    suggestion: 'Check your internet connection or the API endpoint.',
    severity: 'warning',
  },
  {
    pattern: /CORS.*error|blocked by CORS/i,
    title: 'CORS Error',
    description: 'Cross-origin request was blocked.',
    suggestion: 'The API may need to allow requests from your domain.',
    severity: 'warning',
  },

  // Build errors
  {
    pattern: /Build failed/i,
    title: 'Build Failed',
    description: 'The project could not be built.',
    suggestion: 'Check the error details above for specific issues.',
    severity: 'critical',
  },
  {
    pattern: /Port \d+ is.*in use/i,
    title: 'Port Already in Use',
    description: 'Another application is using the required port.',
    suggestion: 'Close the other application or use a different port.',
    severity: 'warning',
  },

  // Generic runtime errors
  {
    pattern: /TypeError:\s*(.+)/i,
    title: 'Type Error',
    description: 'A value was used in an unexpected way.',
    suggestion: 'Check if variables are defined and have the expected type.',
    severity: 'critical',
  },
  {
    pattern: /ReferenceError:\s*(.+)/i,
    title: 'Reference Error',
    description: 'Trying to use a variable that does not exist.',
    suggestion: 'Make sure the variable is defined before using it.',
    severity: 'critical',
  },
  {
    pattern: /RangeError:\s*(.+)/i,
    title: 'Range Error',
    description: 'A number is outside its allowed range.',
    suggestion: 'Check array indices and numeric operations.',
    severity: 'critical',
  },

  // Cannot read properties of undefined/null
  {
    pattern: /Cannot read propert(?:y|ies) of (?:undefined|null)/i,
    title: 'Null Reference',
    description: 'Trying to access a property on undefined or null.',
    suggestion: 'Add a null check or use optional chaining (?.) before accessing the property.',
    severity: 'critical',
  },

  // Invariant Violation
  {
    pattern: /Invariant Violation/i,
    title: 'Invariant Violation',
    description: 'An internal assertion was violated in a library or framework.',
    suggestion: 'Check the error message for details about what went wrong.',
    severity: 'critical',
  },

  // ESM/CJS mismatch
  {
    pattern: /Cannot use import statement outside a module/i,
    title: 'Module Format Error',
    description: 'ES module import syntax used in a CommonJS context.',
    suggestion: 'Add "type": "module" to package.json or use .mjs file extension.',
    severity: 'critical',
  },

  // Dynamic import failure
  {
    pattern: /ChunkLoadError|Failed to fetch dynamically imported module/i,
    title: 'Dynamic Import Failed',
    description: 'A lazily loaded module could not be fetched.',
    suggestion: 'Check that the imported file exists and the path is correct.',
    severity: 'critical',
  },
];

/**
 * Error severity levels with display configuration
 */
export const SEVERITY_CONFIG: Record<
  ErrorSeverity,
  {
    /** Display priority (higher = more important) */
    priority: number;

    /** Should show alert popup */
    showAlert: boolean;

    /** Icon class */
    icon: string;

    /** Color class */
    color: string;
  }
> = {
  critical: {
    priority: 3,
    showAlert: true,
    icon: 'i-ph:x-circle-duotone',
    color: 'text-red-500',
  },
  warning: {
    priority: 2,
    showAlert: true,
    icon: 'i-ph:warning-duotone',
    color: 'text-yellow-500',
  },
  info: {
    priority: 1,
    showAlert: false,
    icon: 'i-ph:info-duotone',
    color: 'text-blue-500',
  },
};

/**
 * Recovery suggestions for known error patterns.
 * Used to enhance AI prompts with fix suggestions.
 */
export const RECOVERY_SUGGESTIONS: Array<{
  /** Pattern to match */
  pattern: RegExp;

  /** Suggestion to add to prompt */
  suggestion: string;
}> = [
  {
    pattern: /@splinetool|spline.*react/i,
    suggestion:
      'Consider wrapping the Spline component in a Suspense boundary with a loading fallback, and add an error boundary to catch loading failures.',
  },
  {
    pattern: /three\.?js|@react-three/i,
    suggestion:
      'For Three.js/R3F components, use React.lazy() for code splitting and add proper error boundaries. Check that all 3D assets are loading correctly.',
  },
  {
    pattern: /tailwindcss|tailwind.*class/i,
    suggestion:
      'Ensure Tailwind CSS is properly configured in tailwind.config.js and the class names are valid. Check for typos in utility class names.',
  },
  {
    pattern: /vite.*plugin|rollup.*plugin/i,
    suggestion:
      'Check vite.config.ts for plugin configuration issues. Ensure all plugins are installed and compatible with your Vite version.',
  },
  {
    pattern: /Element type is invalid/i,
    suggestion:
      "Check the component's export: use `export default` for default imports or `export { Name }` for named imports. Verify the import matches the export type.",
  },
  {
    pattern: /Maximum update depth exceeded/i,
    suggestion:
      'Look for setState calls inside useEffect without a dependency array, or onClick handlers like `onClick={setCount(count + 1)}` that should be `onClick={() => setCount(count + 1)}`.',
  },
  {
    pattern: /must be used within/i,
    suggestion:
      'The component uses a context hook that needs a matching Provider wrapper higher in the component tree. Check the library docs for the required provider component.',
  },
  {
    pattern: /Cannot read propert/i,
    suggestion:
      'Use optional chaining (?.) for property access, initialize state with default values, and add loading guards before rendering data-dependent UI.',
  },
  {
    pattern: /Objects are not valid as a React child/i,
    suggestion:
      'You are rendering a raw object or Date. Use JSON.stringify(), access a specific property, or .map() over arrays to create JSX elements.',
  },
  {
    pattern: /Invalid hook call/i,
    suggestion:
      'Hooks must be called at the top level of function components, not inside conditions, loops, or callbacks. Also check for multiple React versions (npm ls react).',
  },
  {
    pattern: /Invariant Violation/i,
    suggestion:
      'This is a library assertion failure. Check the specific message for details. Common causes: incorrect component nesting, missing providers, or API misuse.',
  },
  {
    pattern: /Cannot use import statement outside/i,
    suggestion:
      'The file uses ESM import syntax but is loaded as CommonJS. Add "type": "module" to package.json, use .mjs extension, or convert to require() syntax.',
  },
  {
    pattern: /ChunkLoadError|dynamically imported module/i,
    suggestion:
      'A lazy-loaded module failed to load. Ensure the file exists, the default export is present, and check for circular dependencies.',
  },
];

/**
 * Patterns that should NEVER be suppressed, even if they match suppression patterns.
 * These are real code errors that need fixing.
 */
const NEVER_SUPPRESS_PATTERNS: RegExp[] = [
  // SyntaxError in module loading - real code issue
  /SyntaxError.*module|module.*SyntaxError/i,

  // Module does not provide an export - missing/wrong import
  /does not provide an export named/i,

  // Cannot find module - missing dependency
  /Cannot find module/i,

  // Module not found - missing import
  /Module not found/i,

  // Failed to resolve import - bad import path
  /Failed to resolve import/i,

  // TypeError in initialization - real code issue
  /TypeError.*undefined|TypeError.*null/i,

  // ReferenceError - undeclared variable
  /ReferenceError/i,

  // Invalid hook call — always a real issue
  /Invalid hook call/i,

  // Element type invalid — wrong import/export
  /Element type is invalid/i,

  // Infinite re-render loop — must be fixed
  /Maximum update depth exceeded/i,

  // Invariant Violation — library assertion failure
  /Invariant Violation/i,

  // ESM/CJS mismatch — config issue
  /Cannot use import statement outside a module/i,
];

/**
 * Check if an error should be suppressed
 */
export function shouldSuppressError(message: string, category: ErrorCategory = 'preview'): boolean {
  // First check if this error should NEVER be suppressed (real code errors)
  const isRealCodeError = NEVER_SUPPRESS_PATTERNS.some((pattern) => pattern.test(message));

  if (isRealCodeError) {
    return false; // Never suppress real code errors
  }

  return SUPPRESSION_PATTERNS.some(({ pattern, categories }) => pattern.test(message) && categories.includes(category));
}

/**
 * Get user-friendly message for an error
 */
export function getUserFriendlyMessage(
  errorMessage: string,
): { title: string; description: string; suggestion?: string; severity: ErrorSeverity } | null {
  for (const mapping of USER_FRIENDLY_MESSAGES) {
    if (mapping.pattern.test(errorMessage)) {
      return {
        title: mapping.title,
        description: mapping.description,
        suggestion: mapping.suggestion,
        severity: mapping.severity,
      };
    }
  }

  return null;
}

/**
 * Get recovery suggestion for an error
 */
export function getRecoverySuggestion(errorMessage: string): string | null {
  for (const { pattern, suggestion } of RECOVERY_SUGGESTIONS) {
    if (pattern.test(errorMessage)) {
      return suggestion;
    }
  }

  return null;
}

/**
 * Classify error severity based on content
 */
export function classifyErrorSeverity(message: string, stack?: string): ErrorSeverity {
  const fullContent = `${message} ${stack || ''}`;

  // Check user-friendly mappings first
  const friendly = getUserFriendlyMessage(message);

  if (friendly) {
    return friendly.severity;
  }

  // Critical patterns
  if (/error|failed|cannot|unable|exception/i.test(message)) {
    return 'critical';
  }

  // Warning patterns
  if (/warning|deprecated|warn/i.test(fullContent)) {
    return 'warning';
  }

  // Default to info for unknown errors
  return 'info';
}
