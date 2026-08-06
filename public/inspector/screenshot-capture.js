// ===========================================================================
// screenshot-capture.js — Screenshot capture module
// Runs INSIDE the preview iframe. Plain JS, no imports.
// Concatenated into a single IIFE by the build script.
//
// html2canvas is loaded at runtime via <script> tag — tries a local bundle
// served from /_bolt-html2canvas.min.js first, falls back to CDN.
// ===========================================================================

/**
 * Local path for html2canvas — written to the user's public/ by the server.
 * Falls back to CDN if the local file fails to load.
 */
const HTML2CANVAS_LOCAL_URL = '/_bolt-html2canvas.min.js';
const HTML2CANVAS_CDN_FALLBACK =
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';

/** @type {boolean} Whether html2canvas has finished loading */
let _html2canvasLoaded = false;

/** @type {boolean} Whether html2canvas is currently being loaded */
let _html2canvasLoading = false;

/** @type {Array<function(html2canvas|null): void>} Pending load callbacks */
const _html2canvasCallbacks = [];

// ---------------------------------------------------------------------------
// html2canvas loader
// ---------------------------------------------------------------------------

/**
 * Lazily loads html2canvas, trying the local bundle first then falling back
 * to CDN. Queues callbacks while loading is in progress so the script tag
 * is only injected once.
 *
 * @param {function(html2canvas|null): void} callback — receives the
 *   html2canvas function on success, or `null` on failure.
 */
function loadHtml2Canvas(callback) {
  if (_html2canvasLoaded && window.html2canvas) {
    callback(window.html2canvas);
    return;
  }

  _html2canvasCallbacks.push(callback);

  if (_html2canvasLoading) {
    return;
  }

  _html2canvasLoading = true;

  _tryLoadScript(HTML2CANVAS_LOCAL_URL, function onLocalLoaded(success) {
    if (success) {
      _html2canvasLoaded = true;
      _html2canvasLoading = false;
      _flushCallbacks(window.html2canvas);
    } else {
      // Fallback to CDN
      _tryLoadScript(HTML2CANVAS_CDN_FALLBACK, function onCdnLoaded(cdnSuccess) {
        _html2canvasLoading = false;

        if (cdnSuccess) {
          _html2canvasLoaded = true;
          _flushCallbacks(window.html2canvas);
        } else {
          _flushCallbacks(null);
        }
      });
    }
  });
}

/**
 * Attempts to load a script from the given URL.
 *
 * @param {string} src — script URL
 * @param {function(boolean): void} done — called with `true` on success, `false` on error
 */
function _tryLoadScript(src, done) {
  var script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.onload = function () { done(true); };
  script.onerror = function () { done(false); };
  document.head.appendChild(script);
}

/**
 * Flushes all queued html2canvas callbacks.
 *
 * @param {html2canvas|null} html2canvasFn
 */
function _flushCallbacks(html2canvasFn) {
  while (_html2canvasCallbacks.length > 0) {
    var cb = _html2canvasCallbacks.shift();
    cb(html2canvasFn);
  }
}

// ---------------------------------------------------------------------------
// Screenshot capture
// ---------------------------------------------------------------------------

/**
 * Captures a screenshot of the current page, scales it to thumbnail
 * dimensions, and sends the result to the parent frame.
 *
 * Falls back to a placeholder image when html2canvas is unavailable or
 * the capture fails.
 *
 * @param {string} requestId — unique identifier to correlate request/response
 * @param {{ width?: number, height?: number }} [options]
 */
async function captureScreenshot(requestId, options) {
  const width = (options && options.width) || 320;
  const height = (options && options.height) || 200;

  loadHtml2Canvas(async function onLibraryReady(html2canvas) {
    if (!html2canvas) {
      sendScreenshotResponse(requestId, generatePlaceholderScreenshot(width, height), true);
      return;
    }

    try {
      // Early exit when the iframe hasn't been laid out yet
      if (window.innerWidth === 0 || window.innerHeight === 0) {
        sendScreenshotResponse(requestId, generatePlaceholderScreenshot(width, height), true);
        return;
      }

      const canvas = await html2canvas(document.body, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#0d1117',
        scale: 0.5,
        logging: false,
        width: window.innerWidth,
        height: window.innerHeight,
        ignoreElements: function (element) {
          // Skip Vite's error overlay custom element — its constructor
          // references `this.root` which is undefined during cloning,
          // causing a TypeError crash in html2canvas.
          var tag = element.tagName && element.tagName.toLowerCase();

          return tag === 'vite-error-overlay';
        },
      });

      // Guard: html2canvas can return a 0-size canvas when the iframe
      // hasn't rendered yet.  Fall back to a placeholder instead of
      // crashing on drawImage / division-by-zero.
      if (!canvas || canvas.width === 0 || canvas.height === 0) {
        sendScreenshotResponse(requestId, generatePlaceholderScreenshot(width, height), true);
        return;
      }

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = width;
      thumbCanvas.height = height;
      const ctx = thumbCanvas.getContext('2d');

      if (!ctx) {
        sendScreenshotResponse(requestId, generatePlaceholderScreenshot(width, height), true);
        return;
      }

      // Cover-fit the source into the thumbnail dimensions
      const srcRatio = canvas.width / canvas.height;
      const destRatio = width / height;
      let srcX = 0;
      let srcY = 0;
      let srcW = canvas.width;
      let srcH = canvas.height;

      if (srcRatio > destRatio) {
        srcW = canvas.height * destRatio;
        srcX = (canvas.width - srcW) / 2;
      } else {
        srcH = canvas.width / destRatio;
      }

      ctx.drawImage(canvas, srcX, srcY, srcW, srcH, 0, 0, width, height);

      const dataUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);
      sendScreenshotResponse(requestId, dataUrl, false);
    } catch (error) {
      console.error('[Preview] Screenshot capture failed:', error);
      sendScreenshotResponse(requestId, generatePlaceholderScreenshot(width, height), true);
    }
  });
}

// ---------------------------------------------------------------------------
// Placeholder generator
// ---------------------------------------------------------------------------

/**
 * Generates a dark-themed placeholder screenshot with a faux browser chrome
 * and skeleton content blocks.
 *
 * @param {number} width  — thumbnail width in px
 * @param {number} height — thumbnail height in px
 * @returns {string} data-URL (PNG)
 */
function generatePlaceholderScreenshot(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return '';
  }

  // Background gradient
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#1a1f2e');
  bgGradient.addColorStop(1, '#0f1219');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Browser chrome bar
  ctx.fillStyle = '#252a38';
  ctx.fillRect(0, 0, width, 28);

  // Traffic-light dots
  ctx.fillStyle = '#ff5f57';
  ctx.beginPath(); ctx.arc(12, 14, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#febc2e';
  ctx.beginPath(); ctx.arc(28, 14, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#28c840';
  ctx.beginPath(); ctx.arc(44, 14, 5, 0, Math.PI * 2); ctx.fill();

  // Faux URL bar
  ctx.fillStyle = '#1a1f2e';
  ctx.beginPath(); ctx.roundRect(60, 6, width - 70, 16, 4); ctx.fill();

  // Skeleton content blocks
  const contentY = 38;
  ctx.fillStyle = '#2d3548';
  ctx.fillRect(0, contentY, width, 32);

  ctx.fillStyle = '#3b82f6';
  ctx.beginPath(); ctx.roundRect(10, contentY + 8, 60, 16, 3); ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(20, contentY + 50, width * 0.6, 20);

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(20, contentY + 78, width * 0.45, 12);

  // Subtle border
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

  return canvas.toDataURL('image/png', 0.8);
}

// ---------------------------------------------------------------------------
// Response sender
// ---------------------------------------------------------------------------

/**
 * Posts a `PREVIEW_SCREENSHOT_RESPONSE` message to the parent frame.
 *
 * @param {string}  requestId     — correlates with the original request
 * @param {string}  dataUrl       — base-64 encoded image
 * @param {boolean} isPlaceholder — `true` when the image is a fallback
 */
function sendScreenshotResponse(requestId, dataUrl, isPlaceholder) {
  try {
    window.parent.postMessage(
      {
        type: 'PREVIEW_SCREENSHOT_RESPONSE',
        requestId: requestId,
        dataUrl: dataUrl,
        isPlaceholder: isPlaceholder,
        timestamp: Date.now(),
      },
      '*',
    );
  } catch (e) {
    console.error('[Preview] Failed to send screenshot response:', e);
  }
}

// ---------------------------------------------------------------------------
// Message listener — registered at module level
// ---------------------------------------------------------------------------

window.addEventListener('message', function onScreenshotMessage(event) {
  if (event.data && event.data.type === 'CAPTURE_SCREENSHOT_REQUEST') {
    captureScreenshot(event.data.requestId, event.data.options || {});
  }
});
