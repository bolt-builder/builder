import { type LoaderFunctionArgs, useRouteError, isRouteErrorResponse, useLoaderData } from 'react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

const PREVIEW_CHANNEL = 'preview-updates';

export async function loader({ params }: LoaderFunctionArgs) {
  const port = params.port;

  if (!port || !/^\d+$/.test(port)) {
    throw new Response('A valid port number is required', { status: 400 });
  }

  return Response.json({ port });
}

export default function PreviewWindow() {
  const { port } = useLoaderData<typeof loader>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');

  /* Handle preview refresh */
  const handleRefresh = useCallback(() => {
    if (iframeRef.current && previewUrl) {
      iframeRef.current.src = '';

      requestAnimationFrame(() => {
        if (iframeRef.current) {
          iframeRef.current.src = previewUrl;
        }
      });
    }
  }, [previewUrl]);

  /* Handle hard refresh with cache-busting for config file changes */
  const handleHardRefresh = useCallback(() => {
    if (iframeRef.current && previewUrl) {
      const url = new URL(previewUrl);
      url.searchParams.set('_t', Date.now().toString());

      iframeRef.current.src = '';

      requestAnimationFrame(() => {
        if (iframeRef.current) {
          iframeRef.current.src = url.toString();
        }
      });
    }
  }, [previewUrl]);

  /* Notify other tabs that this preview is ready */
  const notifyPreviewReady = useCallback(() => {
    if (broadcastChannelRef.current && previewUrl) {
      broadcastChannelRef.current.postMessage({
        type: 'preview-ready',
        previewId: port,
        url: previewUrl,
        timestamp: Date.now(),
      });
    }
  }, [port, previewUrl]);

  useEffect(() => {
    const supportsBroadcastChannel = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function';

    if (supportsBroadcastChannel) {
      broadcastChannelRef.current = new window.BroadcastChannel(PREVIEW_CHANNEL);

      broadcastChannelRef.current.onmessage = (event) => {
        if (event.data.previewId === port) {
          if (event.data.type === 'hard-refresh') {
            handleHardRefresh();
          } else if (event.data.type === 'refresh-preview' || event.data.type === 'file-change') {
            handleRefresh();
          }
        }
      };
    } else {
      broadcastChannelRef.current = null;
    }

    /* Construct the localhost preview URL from the port */
    const url = `http://localhost:${port}`;
    setPreviewUrl(url);

    if (iframeRef.current) {
      iframeRef.current.src = url;
    }

    notifyPreviewReady();

    return () => {
      broadcastChannelRef.current?.close();
    };
  }, [port, handleRefresh, handleHardRefresh, notifyPreviewReady]);

  return (
    <div className="w-full h-full">
      <iframe
        ref={iframeRef}
        title="Preview"
        className="w-full h-full border-none"
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-storage-access-by-user-activation allow-same-origin"
        allow="cross-origin-isolated"
        loading="eager"
        onLoad={notifyPreviewReady}
      />
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  useEffect(() => {
    console.error('[Bolt:PreviewRouteError]', {
      timestamp: new Date().toISOString(),
      route: 'preview.$port',
      ...(isRouteErrorResponse(error)
        ? { status: error.status, statusText: error.statusText, data: error.data }
        : error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { raw: String(error) }),
    });
  }, [error]);

  const message = isRouteErrorResponse(error)
    ? error.data || 'Failed to load the preview.'
    : error instanceof Error
      ? error.message
      : 'An unexpected error occurred while loading the preview.';

  return (
    <div className="flex flex-col items-center justify-center h-full w-full bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary px-6">
      <div className="max-w-md w-full text-center">
        <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-5">
          <div className="i-ph:monitor text-2xl text-red-400" />
        </div>
        <h1 className="text-xl font-bold mb-2">Preview Error</h1>
        <p className="text-sm text-bolt-elements-textSecondary mb-6">{message}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-5 py-2.5 rounded-lg text-sm font-medium bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover transition-colors duration-200"
        >
          Reload Preview
        </button>
        {error instanceof Error && error.stack && (
          <details className="mt-6 text-left w-full">
            <summary className="cursor-pointer text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors">
              Error Details
            </summary>
            <div className="mt-2 p-3 bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg overflow-auto max-h-48">
              <p className="text-xs text-red-400 font-mono font-semibold mb-1.5">
                {error.name}: {error.message}
              </p>
              <pre className="text-xs text-bolt-elements-textTertiary font-mono whitespace-pre-wrap break-words">
                {error.stack}
              </pre>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
