// === Error Capture Module ===
// Forwards console errors and Vite overlay errors to the parent frame.
// Runs inside the preview iframe — plain JS, no imports.

/** @type {typeof console.error} Original console.error before override */
const originalConsoleError = console.error;
/** @type {typeof console.warn} Original console.warn before override */
const originalConsoleWarn = console.warn;

/** @type {number} Timestamp of the last forwarded error */
let lastErrorTime = 0;
/** @type {number} Minimum ms between forwarded errors */
const ERROR_DEBOUNCE_MS = 1000;
/** @type {Set<string>} Recently forwarded error hashes for deduplication */
const recentErrorHashes = new Set();

/**
 * Produces a simple numeric hash of a string for deduplication.
 * Digits are normalized to 'N' and input is truncated to 200 chars
 * so that similar errors with different line numbers collapse together.
 * @param {string} str - The string to hash.
 * @returns {string} Hex-encoded hash.
 */
function hashString(str) {
  let hash = 0;
  const normalized = String(str).replace(/\d+/g, 'N').slice(0, 200);
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Determines whether an error message should be forwarded to the parent.
 * Prevents duplicate messages and enforces a time-based debounce.
 * Hashes expire after 30 seconds so repeated errors can resurface.
 * @param {string} message - The error message to evaluate.
 * @returns {boolean} True if the error should be forwarded.
 */
function shouldForwardError(message) {
  const now = Date.now();
  const errorHash = hashString(message);
  if (recentErrorHashes.has(errorHash)) return false;
  if (now - lastErrorTime < ERROR_DEBOUNCE_MS) return false;
  recentErrorHashes.add(errorHash);
  lastErrorTime = now;
  setTimeout(() => recentErrorHashes.delete(errorHash), 30_000);
  return true;
}

/**
 * Checks whether an error message matches patterns that the AI agent
 * can potentially fix automatically (syntax errors, missing imports, etc.).
 * @param {string} message - The error message to test.
 * @returns {boolean} True if the error matches an auto-fixable pattern.
 */
function isAutoFixableError(message) {
  const autoFixPatterns = [
    /SyntaxError/i, /TypeError/i, /ReferenceError/i,
    /does not provide an export named/i,
    /Cannot find module/i, /Module not found/i,
    /Failed to resolve import/i,
    /\[hmr\].*failed.*reload/i, /Unexpected token/i,
    /is not defined/i, /is not a function/i,
  ];
  return autoFixPatterns.some((pattern) => pattern.test(message));
}

/**
 * Checks if an error originated from inspector/devtools scripts.
 * These errors should NOT be forwarded to AutoFix since they are
 * internal to the inspector tooling, not user code errors.
 * @param {string} message - Error message text.
 * @param {string} [stack] - Stack trace, if available.
 * @returns {boolean} True if the error is from inspector internals.
 */
function isInspectorInternalError(message, stack) {
  var combined = (message || '') + '\n' + (stack || '');
  var inspectorPatterns = [
    /_bolt-inspector/,
    /_bolt-capture/,
    /_bolt-html2canvas/,
    /screenshot-capture/,
    /error-capture\.js/,
    /inspector-core/,
    /vite-error-overlay/,
    /Cannot read properties of undefined \(reading 'frame'\)/,
  ];
  return inspectorPatterns.some(function(p) { return p.test(combined); });
}

/**
 * Forwards a runtime error to the parent frame via postMessage.
 * Only auto-fixable, non-duplicate errors are forwarded.
 * Inspector-internal errors are silently ignored.
 * @param {string} errorType - Category (e.g. 'console.error', 'error', 'unhandledrejection').
 * @param {string} message  - Human-readable error message.
 * @param {string} [stack]  - Stack trace, if available.
 */
function forwardErrorToParent(errorType, message, stack) {
  var fullMessage = String(message);
  if (!shouldForwardError(fullMessage)) return;
  if (!isAutoFixableError(fullMessage)) return;
  if (isInspectorInternalError(fullMessage, stack)) return;
  try {
    window.parent.postMessage({
      type: 'PREVIEW_CONSOLE_ERROR',
      errorType,
      message: fullMessage,
      stack: stack || '',
      url: window.location.href,
      timestamp: Date.now(),
    }, '*');
  } catch (_) { /* Silent fail — parent may be on a different origin */ }
}

// --- Console override ---

console.error = function (...args) {
  originalConsoleError.apply(console, args);
  const message = args.map((arg) => {
    if (arg instanceof Error) return arg.message + (arg.stack ? '\n' + arg.stack : '');
    return String(arg);
  }).join(' ');
  forwardErrorToParent('console.error', message);
};

// --- Global error listeners ---

window.addEventListener('error', (event) => {
  const message = event.message || 'Unknown error';
  const stack = event.error?.stack || `at ${event.filename}:${event.lineno}:${event.colno}`;
  forwardErrorToParent('error', message, stack);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  let message = 'Unhandled Promise Rejection';
  let stack = '';
  if (reason instanceof Error) { message = reason.message; stack = reason.stack || ''; }
  else if (typeof reason === 'string') { message = reason; }
  else if (reason) { message = String(reason); }
  forwardErrorToParent('unhandledrejection', message, stack);
});

// --- Vite error overlay detection ---

/**
 * Extracts error details from a <vite-error-overlay> element's shadow DOM.
 * @param {Element} overlay - The vite-error-overlay element.
 * @returns {{ message: string, fullMessage: string, file: string, stack: string } | null}
 */
function extractViteOverlayError(overlay) {
  try {
    const shadowRoot = overlay.shadowRoot;
    if (!shadowRoot) return null;
    const messageBody = shadowRoot.querySelector('.message-body');
    const fileEl = shadowRoot.querySelector('.file');
    const stackEl = shadowRoot.querySelector('.stack');
    const message = messageBody?.textContent?.trim() || 'Unknown Vite error';
    const file = fileEl?.textContent?.trim() || '';
    const stack = stackEl?.textContent?.trim() || '';
    const fullMessage = [message, file ? `File: ${file}` : '', stack].filter(Boolean).join('\n');
    return { message, fullMessage, file, stack };
  } catch (_) { return null; }
}

/**
 * Sends a Vite overlay error to the parent frame via postMessage.
 * @param {{ message: string, fullMessage: string, file: string, stack: string }} errorInfo
 */
function forwardViteOverlayError(errorInfo) {
  if (!errorInfo || !shouldForwardError(errorInfo.message)) return;
  try {
    window.parent.postMessage({
      type: 'PREVIEW_VITE_ERROR',
      errorType: 'vite-overlay',
      message: errorInfo.message,
      fullMessage: errorInfo.fullMessage,
      file: errorInfo.file,
      stack: errorInfo.stack,
      url: window.location.href,
      timestamp: Date.now(),
    }, '*');
  } catch (_) { /* Silent fail */ }
}

/**
 * Sets up a MutationObserver on the document to detect when Vite injects
 * a <vite-error-overlay> element, then forwards the error details.
 * Also checks for an overlay that already exists at call time.
 */
function setupViteOverlayObserver() {
  const existingOverlay = document.querySelector('vite-error-overlay');
  if (existingOverlay) {
    const errorInfo = extractViteOverlayError(existingOverlay);
    if (errorInfo) forwardViteOverlayError(errorInfo);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeName?.toLowerCase() === 'vite-error-overlay') {
          setTimeout(() => {
            const errorInfo = extractViteOverlayError(node);
            if (errorInfo) forwardViteOverlayError(errorInfo);
          }, 100);
        }
      }
    }
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: false,
  });
}

// --- Bootstrap ---

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupViteOverlayObserver);
} else {
  setupViteOverlayObserver();
}
