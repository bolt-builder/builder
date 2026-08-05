import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconButton } from '~/components/ui/IconButton';
import { csrfFetch } from '~/lib/api/csrf-client';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('BrowserPanel');

/**
 * Built-in browser view (next to Code / Preview). A real server-side Chrome
 * instance renders the page; frames are streamed here over SSE and user
 * input (mouse / keyboard / scroll) is forwarded back. Unlike an iframe
 * this renders any site, including ones that block embedding.
 */

const QUICK_LINKS: Array<{ label: string; url: string; icon: string }> = [
  { label: 'MDN Web Docs', url: 'https://developer.mozilla.org', icon: 'i-ph:file-doc' },
  { label: 'React', url: 'https://react.dev', icon: 'i-ph:atom' },
  { label: 'Tailwind CSS', url: 'https://tailwindcss.com/docs', icon: 'i-ph:paint-brush' },
  { label: 'npm', url: 'https://www.npmjs.com', icon: 'i-ph:package' },
  { label: 'Can I Use', url: 'https://caniuse.com', icon: 'i-ph:check-square' },
  { label: 'DevDocs', url: 'https://devdocs.io', icon: 'i-ph:books' },
];

const MOUSE_BUTTONS: Record<number, 'left' | 'middle' | 'right'> = {
  0: 'left',
  1: 'middle',
  2: 'right',
};

/** Keys forwarded on keydown/keyup; printable characters go through insertText. */
const CONTROL_KEYS = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Shift',
  'Control',
  'Alt',
  'Meta',
]);

function normalizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();

  if (!trimmed) {
    return undefined;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Looks like a domain or domain/path → default to https
  if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(trimmed)) {
    return `https://${trimmed}`;
  }

  // Anything else becomes a DuckDuckGo search
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

interface FrameMessage {
  type: 'frame';
  data: string;
  width: number;
  height: number;
}

interface StateMessage {
  type: 'state';
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

async function postBrowserOp(body: Record<string, unknown>): Promise<Response> {
  return csrfFetch('/api/browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const BrowserPanel = memo(() => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const frameSizeRef = useRef<{ width: number; height: number }>({ width: 1280, height: 720 });
  const lastMoveSentRef = useRef(0);
  const frameSeqRef = useRef(0);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [currentUrl, setCurrentUrl] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const urlInputFocusedRef = useRef(false);

  /**
   * Draw an incoming frame onto the canvas. Decoding into an Image first and
   * painting only when decode completes avoids the flicker an <img> src swap
   * produces (blank while the new JPEG decodes), which showed up as glitching
   * during page navigations. A sequence counter drops stale frames that
   * finish decoding out of order.
   */
  const drawFrame = useCallback((frame: FrameMessage) => {
    const seq = ++frameSeqRef.current;
    const image = new Image();

    image.onload = () => {
      if (seq !== frameSeqRef.current) {
        return; // A newer frame already decoded
      }

      const canvas = canvasRef.current;

      if (!canvas) {
        return;
      }

      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }

      frameSizeRef.current = { width: frame.width, height: frame.height };
      canvas.getContext('2d')?.drawImage(image, 0, 0, frame.width, frame.height);
      setHasFrame(true);
    };
    image.src = `data:image/jpeg;base64,${frame.data}`;
  }, []);

  /** Ensure a server browser session + SSE stream exist; returns sessionId. */
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) {
      return sessionIdRef.current;
    }

    setIsConnecting(true);
    setSessionError(null);

    try {
      const rect = viewportRef.current?.getBoundingClientRect();
      const response = await postBrowserOp({
        op: 'create',
        width: rect ? Math.round(rect.width) : undefined,
        height: rect ? Math.round(rect.height) : undefined,
      });
      const json = (await response.json()) as { data?: { sessionId?: string }; error?: { message?: string } };

      if (!response.ok || !json.data?.sessionId) {
        throw new Error(json.error?.message || 'Failed to start the embedded browser');
      }

      const id = json.data.sessionId;
      sessionIdRef.current = id;
      setSessionId(id);

      const eventSource = new EventSource(`/api/browser?op=stream&sessionId=${encodeURIComponent(id)}`);
      eventSourceRef.current = eventSource;

      eventSource.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as FrameMessage | StateMessage | { type: string; error?: string };

          if (message.type === 'frame') {
            drawFrame(message as FrameMessage);
          } else if (message.type === 'state') {
            const state = message as StateMessage;

            if (state.url && state.url !== 'about:blank') {
              setCurrentUrl(state.url);

              if (!urlInputFocusedRef.current) {
                setInputValue(state.url);
              }
            }

            setIsLoading(state.loading);
            setCanGoBack(state.canGoBack);
            setCanGoForward(state.canGoForward);
          } else if (message.type === 'error') {
            setSessionError((message as { error?: string }).error || 'Browser stream error');
          }
        } catch (err) {
          logger.error('Failed to parse browser stream message', err);
        }
      };

      eventSource.onerror = () => {
        if (eventSource.readyState === EventSource.CLOSED) {
          logger.warn('Browser stream closed');
        }
      };

      return id;
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err));

      return null;
    } finally {
      setIsConnecting(false);
    }
  }, [drawFrame]);

  // Tear the session down when the panel unmounts.
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;

      const id = sessionIdRef.current;

      if (id) {
        sessionIdRef.current = null;
        void postBrowserOp({ op: 'close', sessionId: id }).catch(() => {});
      }
    };
  }, []);

  // Keep the remote viewport matched to the panel size.
  useEffect(() => {
    if (!sessionId || !viewportRef.current) {
      return undefined;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (!entry) {
        return;
      }

      if (timeout) {
        clearTimeout(timeout);
      }

      timeout = setTimeout(() => {
        const { width, height } = entry.contentRect;

        if (width > 0 && height > 0 && sessionIdRef.current) {
          void postBrowserOp({
            op: 'resize',
            sessionId: sessionIdRef.current,
            width: Math.round(width),
            height: Math.round(height),
          }).catch(() => {});
        }
      }, 300);
    });

    observer.observe(viewportRef.current);

    return () => {
      observer.disconnect();

      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [sessionId]);

  const navigateTo = useCallback(
    async (url: string) => {
      setIsLoading(true);
      setCurrentUrl(url);
      setInputValue(url);

      const id = await ensureSession();

      if (!id) {
        setIsLoading(false);
        return;
      }

      void postBrowserOp({ op: 'navigate', sessionId: id, url }).catch(() => setIsLoading(false));
    },
    [ensureSession],
  );

  const goBack = useCallback(() => {
    if (sessionIdRef.current) {
      void postBrowserOp({ op: 'back', sessionId: sessionIdRef.current }).catch(() => {});
    }
  }, []);

  const goForward = useCallback(() => {
    if (sessionIdRef.current) {
      void postBrowserOp({ op: 'forward', sessionId: sessionIdRef.current }).catch(() => {});
    }
  }, []);

  const reload = useCallback(() => {
    if (sessionIdRef.current) {
      setIsLoading(true);
      void postBrowserOp({ op: 'reload', sessionId: sessionIdRef.current }).catch(() => {});
    }
  }, []);

  const onSubmit = useCallback(() => {
    const url = normalizeUrl(inputValue);

    if (url) {
      void navigateTo(url);
    }
  }, [inputValue, navigateTo]);

  const openInNewTab = useCallback(() => {
    if (currentUrl) {
      window.open(currentUrl, '_blank', 'noopener,noreferrer');
    }
  }, [currentUrl]);

  /**
   * Map a pointer event on the scaled canvas to remote page coordinates,
   * accounting for object-contain letterboxing so clicks near the edges
   * don't drift when the panel and page aspect ratios differ.
   */
  const toRemoteCoords = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    const { width: frameWidth, height: frameHeight } = frameSizeRef.current;
    const scale = Math.min(rect.width / frameWidth, rect.height / frameHeight);
    const contentWidth = frameWidth * scale;
    const contentHeight = frameHeight * scale;
    const offsetX = (rect.width - contentWidth) / 2;
    const offsetY = (rect.height - contentHeight) / 2;
    const x = (event.clientX - rect.left - offsetX) / scale;
    const y = (event.clientY - rect.top - offsetY) / scale;

    return { x: Math.max(0, Math.min(frameWidth, x)), y: Math.max(0, Math.min(frameHeight, y)) };
  }, []);

  const sendMouse = useCallback((event: Record<string, unknown>) => {
    if (sessionIdRef.current) {
      void postBrowserOp({ op: 'mouse', sessionId: sessionIdRef.current, event }).catch(() => {});
    }
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      viewportRef.current?.focus();

      const coords = toRemoteCoords(event);

      if (coords) {
        sendMouse({
          kind: 'down',
          ...coords,
          button: MOUSE_BUTTONS[event.button] ?? 'left',
          clickCount: event.detail > 0 ? Math.min(event.detail, 3) : 1,
        });
      }
    },
    [sendMouse, toRemoteCoords],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const coords = toRemoteCoords(event);

      if (coords) {
        sendMouse({ kind: 'up', ...coords, button: MOUSE_BUTTONS[event.button] ?? 'left' });
      }
    },
    [sendMouse, toRemoteCoords],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const now = Date.now();

      // Throttle move events to ~30/s
      if (now - lastMoveSentRef.current < 33) {
        return;
      }

      lastMoveSentRef.current = now;

      const coords = toRemoteCoords(event);

      if (coords) {
        sendMouse({ kind: 'move', ...coords });
      }
    },
    [sendMouse, toRemoteCoords],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      const coords = toRemoteCoords(event);

      if (coords) {
        sendMouse({ kind: 'wheel', ...coords, deltaX: event.deltaX, deltaY: event.deltaY });
      }
    },
    [sendMouse, toRemoteCoords],
  );

  const sendKey = useCallback((event: Record<string, unknown>) => {
    if (sessionIdRef.current) {
      void postBrowserOp({ op: 'key', sessionId: sessionIdRef.current, event }).catch(() => {});
    }
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!sessionIdRef.current) {
        return;
      }

      event.preventDefault();

      const hasModifier = event.ctrlKey || event.metaKey || event.altKey;

      if (event.key.length === 1 && !hasModifier) {
        sendKey({ kind: 'insertText', text: event.key });
      } else if (CONTROL_KEYS.has(event.key) || hasModifier) {
        sendKey({ kind: 'down', key: event.key });
      }
    },
    [sendKey],
  );

  const onKeyUp = useCallback(
    (event: React.KeyboardEvent) => {
      if (!sessionIdRef.current) {
        return;
      }

      if (CONTROL_KEYS.has(event.key) || event.ctrlKey || event.metaKey || event.altKey) {
        sendKey({ kind: 'up', key: event.key });
      }
    },
    [sendKey],
  );

  const quickLinks = useMemo(() => QUICK_LINKS, []);
  const showRemoteView = Boolean(currentUrl && !sessionError);

  return (
    <div className="w-full h-full flex flex-col bg-devonz-elements-background-depth-1">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-devonz-elements-borderColor bg-devonz-elements-background-depth-2">
        <IconButton icon="i-ph:caret-left" aria-label="Go back" disabled={!canGoBack} onClick={goBack} />
        <IconButton icon="i-ph:caret-right" aria-label="Go forward" disabled={!canGoForward} onClick={goForward} />
        <IconButton icon="i-ph:arrow-clockwise" aria-label="Reload page" disabled={!currentUrl} onClick={reload} />

        <div className="flex-grow flex items-center gap-1 bg-devonz-elements-background-depth-1 border border-devonz-elements-borderColor rounded-full px-3 py-1 text-sm focus-within:border-accent-500/60 transition-colors">
          <span
            className={
              isLoading || isConnecting
                ? 'i-svg-spinners:90-ring-with-bg text-accent-500 shrink-0'
                : 'i-ph:globe-simple text-devonz-elements-textTertiary shrink-0'
            }
          />
          <input
            aria-label="Browser URL"
            className="w-full bg-transparent outline-none text-xs font-mono truncate text-devonz-elements-textPrimary placeholder-devonz-elements-textTertiary"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Enter a URL or search…"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            onFocus={() => {
              urlInputFocusedRef.current = true;
            }}
            onBlur={() => {
              urlInputFocusedRef.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onSubmit();
                (event.target as HTMLInputElement).blur();
              }
            }}
            onClick={(event) => (event.target as HTMLInputElement).select()}
          />
        </div>

        <IconButton
          icon="i-ph:arrow-square-out"
          aria-label="Open in new tab"
          disabled={!currentUrl}
          onClick={openInNewTab}
        />
      </div>

      {/* Content */}
      <div className="flex-1 relative min-h-0">
        {showRemoteView ? (
          <div
            ref={viewportRef}
            tabIndex={0}
            role="application"
            aria-label="Embedded browser page"
            className="w-full h-full bg-devonz-elements-background-depth-2 outline-none overflow-hidden relative"
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerMove={onPointerMove}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onContextMenu={(event) => event.preventDefault()}
          >
            {isLoading && (
              <div className="absolute top-0 left-0 right-0 h-0.5 z-10 overflow-hidden">
                <div className="h-full w-1/3 bg-accent-500 browser-loading-bar" />
              </div>
            )}
            <canvas
              ref={canvasRef}
              aria-label="Browser page"
              className={`w-full h-full object-contain select-none ${hasFrame ? '' : 'opacity-0'}`}
            />
            {!hasFrame && (
              <div className="absolute inset-0 flex items-center justify-center text-devonz-elements-textTertiary">
                <span className="i-svg-spinners:90-ring-with-bg text-2xl" />
              </div>
            )}
          </div>
        ) : sessionError ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-3 px-8 text-center text-devonz-elements-textSecondary">
            <span className="i-ph:warning-circle text-4xl text-devonz-elements-icon-error" />
            <p className="text-sm font-medium text-devonz-elements-textPrimary">Embedded browser unavailable</p>
            <p className="text-xs max-w-md text-devonz-elements-textTertiary">{sessionError}</p>
            <button
              onClick={() => {
                setSessionError(null);

                if (currentUrl) {
                  void navigateTo(currentUrl);
                }
              }}
              className="mt-2 px-3 py-1.5 rounded-lg border border-devonz-elements-borderColor bg-devonz-elements-background-depth-2 hover:bg-devonz-elements-background-depth-3 text-xs text-devonz-elements-textPrimary transition-colors"
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-6 text-devonz-elements-textSecondary">
            <div className="flex flex-col items-center gap-2">
              <span className="i-ph:globe-hemisphere-west text-5xl text-devonz-elements-textTertiary" />
              <p className="text-sm">Browse the web without leaving the workbench</p>
              <p className="text-xs text-devonz-elements-textTertiary">
                Rendered by a real Chrome instance — works on any site
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {quickLinks.map((link) => (
                <button
                  key={link.url}
                  onClick={() => void navigateTo(link.url)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-devonz-elements-borderColor bg-devonz-elements-background-depth-2 hover:bg-devonz-elements-background-depth-3 hover:border-accent-500/40 text-xs text-devonz-elements-textPrimary transition-colors"
                >
                  <span className={`${link.icon} text-base text-accent-500`} />
                  {link.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

BrowserPanel.displayName = 'BrowserPanel';
