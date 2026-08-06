/**
 * @module local-filesystem
 * Server-side filesystem implementation using Node.js native `fs` module.
 *
 * All operations are scoped to a project directory. Paths are resolved
 * relative to the project root and validated against traversal attacks.
 *
 * @remarks This module is SERVER-ONLY — it imports `node:fs/promises` and
 * `node:path` which are not available in the browser.
 */

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import type { RuntimeFileSystem, DirEntry, FileStat, WatchEvent, WatchCallback, Disposer } from './runtime-provider';
import { isSafePath } from './runtime-provider';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('LocalFileSystem');

/*
 * Screenshot capture script injection
 *
 * The preview iframe must include a small JS snippet that listens for
 * CAPTURE_SCREENSHOT_REQUEST messages and responds with html2canvas renders.
 *
 * Two injection paths:
 *   1. Static HTML apps  → inline <script> injected into index.html
 *   2. Server-rendered apps (Next.js, Remix, etc.) → external _bolt-capture.js
 *      written to public/ and a <script> tag injected into root layout files
 */

/** The capture JS as a raw string (reused for both inline and external). */
const CAPTURE_JS = `(function(){var L=false,G=false,C=[];function lh(cb){if(L&&window.html2canvas){cb(window.html2canvas);return}C.push(cb);if(G)return;G=true;var s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";s.async=true;s.onload=function(){L=true;G=false;while(C.length)C.shift()(window.html2canvas)};s.onerror=function(){G=false;while(C.length)C.shift()(null)};document.head.appendChild(s)}window.addEventListener("message",function(e){if(e.data&&e.data.type==="CAPTURE_SCREENSHOT_REQUEST"){var rid=e.data.requestId,o=e.data.options||{},mw=o.width||960,mh=o.height||600;lh(function(h2c){if(!h2c){window.parent.postMessage({type:"PREVIEW_SCREENSHOT_RESPONSE",requestId:rid,dataUrl:"",isPlaceholder:true},"*");return}var fh=Math.min(Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,window.innerHeight),4000);h2c(document.body,{useCORS:true,allowTaint:true,backgroundColor:"#0d1117",scale:1,logging:false,width:window.innerWidth,height:fh,windowHeight:fh,ignoreElements:function(el){return el.tagName&&el.tagName.toLowerCase()==="vite-error-overlay"}}).then(function(cv){var r=Math.min(mw/cv.width,mh/cv.height,1),tw=Math.round(cv.width*r),th=Math.round(cv.height*r),tc=document.createElement("canvas");tc.width=tw;tc.height=th;var cx=tc.getContext("2d");if(cx){cx.drawImage(cv,0,0,cv.width,cv.height,0,0,tw,th);window.parent.postMessage({type:"PREVIEW_SCREENSHOT_RESPONSE",requestId:rid,dataUrl:tc.toDataURL("image/webp",0.85),isPlaceholder:false},"*")}}).catch(function(){window.parent.postMessage({type:"PREVIEW_SCREENSHOT_RESPONSE",requestId:rid,dataUrl:"",isPlaceholder:true},"*")})})}})})();`;

/* ── Path 1: index.html inline injection ────────────────────────────────── */

const CAPTURE_MARKER_START = '<!-- bolt:capture-start -->';
const CAPTURE_MARKER_END = '<!-- bolt:capture-end -->';

const CAPTURE_SCRIPT = `${CAPTURE_MARKER_START}<script>${CAPTURE_JS}</script>${CAPTURE_MARKER_END}`;

/** Regex to match the injected capture block (including newlines). */
const CAPTURE_BLOCK_RE = new RegExp(
  `\\s*${CAPTURE_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CAPTURE_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  'g',
);

/** Check if a path is an index.html entry point. */
function isIndexHtml(filePath: string): boolean {
  const base = nodePath.basename(filePath);
  return base === 'index.html';
}

/** Strip the injected capture block from HTML content. */
function stripCaptureScript(html: string): string {
  return html.replace(CAPTURE_BLOCK_RE, '');
}

/** Inject the capture script and inspector tag into HTML content (before </head> or </body>). */
function injectCaptureScript(html: string): string {
  // Remove any existing injections first
  let clean = stripCaptureScript(html);
  clean = stripInspectorTag(clean);

  // Build the combined injection (capture inline + inspector external)
  const injection = getInspectorScript() ? `${CAPTURE_SCRIPT}\n${INSPECTOR_TAG}` : CAPTURE_SCRIPT;

  // Inject before </head> if present, otherwise before </body>, otherwise append
  if (clean.includes('</head>')) {
    clean = clean.replace('</head>', `${injection}\n</head>`);
  } else if (clean.includes('</body>')) {
    clean = clean.replace('</body>', `${injection}\n</body>`);
  } else {
    clean += `\n${injection}`;
  }

  return clean;
}

/* ── Inspector script injection ─────────────────────────────────────────── */

/**
 * Build the inspector script from modular source files in `public/inspector/`.
 */
import { getInspectorScript, getHtml2CanvasScript } from '~/lib/inspector/build-inspector-script';

/** Name of the external inspector script written to the user's public/. */
const INSPECTOR_SCRIPT_FILENAME = '_bolt-inspector.js';

/** Tag injected into HTML files. Uses a data attribute as a stripping marker. */
const INSPECTOR_TAG = `<script src="/${INSPECTOR_SCRIPT_FILENAME}" data-bolt-inspector="true"></script>`;

/** Regex to strip the injected inspector script tag. */
const INSPECTOR_TAG_RE = /\s*<script\s[^>]*data-bolt-inspector[^>]*><\/script>/g;

/** Strip the inspector script tag from file content. */
function stripInspectorTag(content: string): string {
  return content.replace(INSPECTOR_TAG_RE, '');
}

/* ── Path 2: Root layout injection (Next.js App Router, etc.) ───────────── */

/** Name of the external capture script written to public/. */
const CAPTURE_SCRIPT_FILENAME = '_bolt-capture.js';

/** Tag injected into root layout files. Uses a data attribute as a marker. */
const LAYOUT_CAPTURE_TAG = `<script src="/${CAPTURE_SCRIPT_FILENAME}" data-bolt-capture="true"></script>`;

/** Regex to strip the injected layout capture tag. */
const LAYOUT_CAPTURE_RE = /\s*<script\s[^>]*data-bolt-capture[^>]*><\/script>/g;

/** Name of the html2canvas bundle written to the user's public/. */
const HTML2CANVAS_FILENAME = '_bolt-html2canvas.min.js';

/**
 * Check if a path + content represents a root HTML layout file.
 * Matches Next.js App Router layouts (layout.tsx/jsx) that render the full
 * `<html>` document with a `</body>` closing tag.
 */
function isRootLayout(filePath: string, content: string): boolean {
  const base = nodePath.basename(filePath);

  if (!/^layout\.(tsx|jsx|ts|js)$/.test(base)) {
    return false;
  }

  // Must render the full HTML shell (lowercase <html or PascalCase <Html)
  return (content.includes('<html') || content.includes('<Html')) && content.includes('</body>');
}

/** Strip the capture script tag from root layout content. */
function stripLayoutCaptureTag(content: string): string {
  return content.replace(LAYOUT_CAPTURE_RE, '');
}

/** Inject the capture and inspector script references into a root layout (before </body>). */
function injectLayoutCaptureTag(content: string): string {
  let clean = stripLayoutCaptureTag(content);
  clean = stripInspectorTag(clean);

  // Build the combined injection tags
  const tags = getInspectorScript() ? `${LAYOUT_CAPTURE_TAG}\n${INSPECTOR_TAG}` : LAYOUT_CAPTURE_TAG;

  if (clean.includes('</body>')) {
    return clean.replace('</body>', `${tags}\n</body>`);
  }

  return clean;
}

/**
 * Node.js native filesystem implementation for local project execution.
 *
 * Every path operation:
 * 1. Validates the path is safe (no traversal)
 * 2. Resolves it against the project root
 * 3. Performs the native fs operation
 */
export class LocalFileSystem implements RuntimeFileSystem {
  readonly #root: string;
  #captureScriptWritten = false;
  #inspectorScriptWritten = false;
  #html2canvasWritten = false;

  constructor(projectRoot: string) {
    this.#root = nodePath.resolve(projectRoot);
  }

  /**
   * Write the external capture script to public/_bolt-capture.js.
   * Skips if already written this session (idempotent).
   */
  async #ensureCaptureScriptFile(): Promise<void> {
    if (this.#captureScriptWritten) {
      return;
    }

    const publicDir = nodePath.join(this.#root, 'public');
    await fs.mkdir(publicDir, { recursive: true });

    const captureFile = nodePath.join(publicDir, CAPTURE_SCRIPT_FILENAME);
    await fs.writeFile(captureFile, CAPTURE_JS, 'utf-8');
    this.#captureScriptWritten = true;

    logger.debug('Wrote external capture script to public/_bolt-capture.js');
  }

  /**
   * Write the inspector script to public/_bolt-inspector.js.
   * Skips if already written this session or if the inspector source is unavailable.
   */
  async #ensureInspectorScriptFile(): Promise<void> {
    const inspectorScript = getInspectorScript();

    if (this.#inspectorScriptWritten || !inspectorScript) {
      return;
    }

    const publicDir = nodePath.join(this.#root, 'public');
    await fs.mkdir(publicDir, { recursive: true });

    const inspectorFile = nodePath.join(publicDir, INSPECTOR_SCRIPT_FILENAME);

    await fs.writeFile(inspectorFile, inspectorScript, 'utf-8');
    this.#inspectorScriptWritten = true;

    logger.debug('Wrote inspector script to public/_bolt-inspector.js');
  }

  /**
   * Ensure the inspector, capture, and html2canvas scripts are written to
   * the project's `public/` directory.  Call this early — e.g. from
   * `RuntimeClient.boot()` — so the scripts are available even for
   * projects restored from disk that skip the `writeFile()` injection path.
   */
  async ensureInspectorReady(): Promise<void> {
    await this.#ensureInspectorScriptFile();
    await this.#ensureCaptureScriptFile();
    await this.#ensureHtml2CanvasFile();
  }

  /**
   * Write the html2canvas bundle to public/_bolt-html2canvas.min.js.
   * Skips if already written this session or if the bundle is unavailable.
   */
  async #ensureHtml2CanvasFile(): Promise<void> {
    if (this.#html2canvasWritten) {
      return;
    }

    const html2canvasContent = getHtml2CanvasScript();

    if (!html2canvasContent) {
      return;
    }

    const publicDir = nodePath.join(this.#root, 'public');
    await fs.mkdir(publicDir, { recursive: true });

    const html2canvasFile = nodePath.join(publicDir, HTML2CANVAS_FILENAME);
    await fs.writeFile(html2canvasFile, html2canvasContent, 'utf-8');
    this.#html2canvasWritten = true;

    logger.debug('Wrote html2canvas bundle to public/_bolt-html2canvas.min.js');
  }

  /** Resolve a relative path to an absolute path within the project root. */
  #resolve(relativePath: string): string {
    if (!isSafePath(relativePath)) {
      throw new Error(`Path traversal rejected: ${relativePath}`);
    }

    const resolved = nodePath.resolve(this.#root, relativePath);

    // Double-check: resolved path must be within root
    if (!resolved.startsWith(this.#root)) {
      throw new Error(`Path escapes project boundary: ${relativePath}`);
    }

    return resolved;
  }

  async readFile(path: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    const resolved = this.#resolve(path);
    let content = await fs.readFile(resolved, { encoding });

    // Strip injected capture script so editor/git see clean content
    if (isIndexHtml(path) && content.includes(CAPTURE_MARKER_START)) {
      content = stripCaptureScript(content);
    }

    // Strip injected capture tag from root layout files
    if (content.includes('data-bolt-capture') && isRootLayout(path, content)) {
      content = stripLayoutCaptureTag(content);
    }

    // Strip injected inspector tag so editor/git see clean content
    if (content.includes('data-bolt-inspector')) {
      content = stripInspectorTag(content);
    }

    return content;
  }

  async readFileRaw(path: string): Promise<Uint8Array> {
    const resolved = this.#resolve(path);
    const buffer = await fs.readFile(resolved);

    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.#resolve(path);
    const dir = nodePath.dirname(resolved);

    /*
     * Guard: never allow external callers to overwrite the managed
     * inspector / capture / html2canvas bundles with stale content
     * (e.g. from the client-side FilesStore replay).
     */
    const baseName = nodePath.basename(path);
    const managedFiles = new Set([INSPECTOR_SCRIPT_FILENAME, CAPTURE_SCRIPT_FILENAME, HTML2CANVAS_FILENAME]);

    if (managedFiles.has(baseName)) {
      logger.debug(`Skipping write for managed file: ${baseName}`);

      return;
    }

    // Auto-create parent directories
    await fs.mkdir(dir, { recursive: true });

    if (content instanceof Uint8Array) {
      await fs.writeFile(resolved, content);
    } else {
      let finalContent = content;

      if (isIndexHtml(path)) {
        // Path 1: inject inline capture script + external inspector into static HTML
        finalContent = injectCaptureScript(content);
        await this.#ensureInspectorScriptFile();
        await this.#ensureHtml2CanvasFile();
      } else if (isRootLayout(path, content)) {
        // Path 2: inject external script references into framework root layouts
        finalContent = injectLayoutCaptureTag(content);
        await this.#ensureCaptureScriptFile();
        await this.#ensureInspectorScriptFile();
        await this.#ensureHtml2CanvasFile();
      }

      await fs.writeFile(resolved, finalContent, 'utf-8');
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const resolved = this.#resolve(path);
    await fs.mkdir(resolved, { recursive: options?.recursive ?? false });
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const resolved = this.#resolve(path);
    const entries = await fs.readdir(resolved, { withFileTypes: true });

    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  }

  async stat(path: string): Promise<FileStat> {
    const resolved = this.#resolve(path);
    const stats = await fs.stat(resolved);

    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      size: stats.size,
      mtime: stats.mtime.toISOString(),
    };
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const resolved = this.#resolve(path);

    await fs.rm(resolved, {
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    });
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.#resolve(path);

    try {
      await fs.access(resolved);
      return true;
    } catch {
      return false;
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const resolvedOld = this.#resolve(oldPath);
    const resolvedNew = this.#resolve(newPath);

    // Auto-create destination parent directory
    const destDir = nodePath.dirname(resolvedNew);
    await fs.mkdir(destDir, { recursive: true });

    await fs.rename(resolvedOld, resolvedNew);
  }

  /**
   * Watch for file-system changes using Node.js `fs.watch` (recursive).
   *
   * @remarks Uses native `fs.watch` with `{ recursive: true }` which is
   * supported on macOS and Windows. On Linux, recursive watching requires
   * `chokidar` — we'll add that dependency in Phase 2 if needed.
   * For Phase 1 this provides basic watch capability.
   */
  watch(glob: string, callback: WatchCallback): Disposer {
    const watchers: FSWatcher[] = [];

    // Buffer events to avoid flooding the callback
    let pending: WatchEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const FLUSH_DELAY = 100;

    const flush = () => {
      if (pending.length > 0) {
        const batch = [...pending];
        pending = [];
        callback(batch);
      }

      flushTimer = null;
    };

    const scheduleFlush = () => {
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, FLUSH_DELAY);
      }
    };

    try {
      const watcher = fsWatch(this.#root, { recursive: true }, (eventType, filename) => {
        if (!filename) {
          return;
        }

        // Normalize path separators
        const normalizedPath = filename.replace(/\\/g, '/');

        // Skip node_modules, .git, and other noisy directories
        if (
          normalizedPath.startsWith('node_modules/') ||
          normalizedPath.startsWith('.git/') ||
          normalizedPath.includes('/node_modules/') ||
          normalizedPath.includes('/.git/')
        ) {
          return;
        }

        if (glob !== '**/*' && glob !== '*') {
          // Basic extension matching: `*.ts` → ends with .ts
          if (glob.startsWith('*.')) {
            const ext = glob.slice(1);

            if (!normalizedPath.endsWith(ext)) {
              return;
            }
          }
        }

        const watchEvent: WatchEvent = {
          type: eventType === 'rename' ? 'add' : 'change',
          path: normalizedPath,
        };

        pending.push(watchEvent);
        scheduleFlush();
      });

      watchers.push(watcher);
    } catch (error) {
      logger.warn('Failed to start file watcher:', error);
    }

    return () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }

      for (const watcher of watchers) {
        watcher.close();
      }
    };
  }
}
