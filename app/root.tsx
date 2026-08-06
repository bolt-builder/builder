import * as Sentry from '@sentry/react';
import { useStore } from '@nanostores/react';
import type { LinksFunction } from 'react-router';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError, isRouteErrorResponse } from 'react-router';
import tailwindReset from '@unocss/reset/tailwind-compat.css?url';
import { themeStore } from './lib/stores/theme';
import { stripIndents } from './utils/stripIndent';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { useSentryUser } from './hooks/useSentryUser';
import { Toaster } from 'sonner';

import globalStyles from './styles/index.scss?url';
import liquidMetalStyles from './styles/liquid-metal.css?url';
import xtermStyles from '@xterm/xterm/css/xterm.css?url';

import 'virtual:uno.css';

const DndWrapper = lazy(async () => {
  if (typeof window === 'undefined') {
    return { default: ({ children }: { children: ReactNode }) => <>{children}</> };
  }

  return import('./components/DndWrapper.client');
});

export const links: LinksFunction = () => [
  {
    rel: 'icon',
    href: '/favicon.svg',
    type: 'image/svg+xml',
  },
  {
    rel: 'apple-touch-icon',
    href: '/apple-touch-icon.png',
  },
  {
    rel: 'manifest',
    href: '/manifest.json',
  },
  { rel: 'stylesheet', href: tailwindReset },
  { rel: 'stylesheet', href: globalStyles },
  { rel: 'stylesheet', href: liquidMetalStyles },
  { rel: 'stylesheet', href: xtermStyles },
  {
    rel: 'preconnect',
    href: 'https://fonts.googleapis.com',
  },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'dns-prefetch',
    href: 'https://cdn.simpleicons.org',
  },
  {
    rel: 'dns-prefetch',
    href: 'https://api.github.com',
  },
  {
    rel: 'dns-prefetch',
    href: 'https://api.netlify.com',
  },
  {
    rel: 'dns-prefetch',
    href: 'https://gitlab.com',
  },
  {
    rel: 'dns-prefetch',
    href: 'https://vercel.com',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  },
];

const inlineThemeCode = stripIndents`
  setTutorialKitTheme();

  function setTutorialKitTheme() {
    let theme = localStorage.getItem('bolt_theme');

    if (!theme) {
      theme = 'dark';
    }

    document.querySelector('html')?.setAttribute('data-theme', theme);
  }
`;

export function Layout({ children }: { children: React.ReactNode }) {
  const theme = useStore(themeStore);

  useSentryUser();

  useEffect(() => {
    document.querySelector('html')?.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <html lang="en" data-theme={theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <meta name="theme-color" content="#0a0a0a" />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: inlineThemeCode }} />
      </head>
      <body>
        <noscript>
          <p style={{ padding: '2rem', color: '#fff', background: '#0a0a0a', textAlign: 'center' }}>
            JavaScript is required to use Bolt.
          </p>
        </noscript>
        <div id="root" className="w-full h-full">
          <Suspense fallback={<>{children}</>}>
            <DndWrapper>{children}</DndWrapper>
          </Suspense>
          <Toaster position="bottom-right" theme="dark" richColors closeButton duration={3000} />
        </div>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

import { logStore } from './lib/stores/logs';

export function SentryErrorBoundary() {
  const error = useRouteError();
  Sentry.captureException(error);

  useEffect(() => {
    console.error('[Bolt:RouteError]', {
      type: isRouteErrorResponse(error) ? 'route-response' : 'exception',
      timestamp: new Date().toISOString(),
      ...(isRouteErrorResponse(error)
        ? { status: error.status, statusText: error.statusText, data: error.data }
        : error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { raw: String(error) }),
    });
  }, [error]);

  if (isRouteErrorResponse(error)) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary px-6">
        <div className="max-w-lg w-full text-center">
          <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-6">
            <div className="i-ph:warning-circle-duotone text-3xl text-red-400" />
          </div>
          <h1 className="text-5xl font-bold mb-2 text-red-400">{error.status}</h1>
          <h2 className="text-xl font-semibold mb-3 text-bolt-elements-textPrimary">{error.statusText}</h2>
          <p className="text-sm text-bolt-elements-textSecondary mb-8">{error.data}</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => window.history.back()}
              className="px-5 py-2.5 rounded-lg text-sm font-medium border border-bolt-elements-borderColor bg-transparent text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2 transition-colors duration-200"
            >
              Go Back
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-5 py-2.5 rounded-lg text-sm font-medium bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover transition-colors duration-200"
            >
              Reload Page
            </button>
          </div>
          {!import.meta.env.PROD && (
            <details className="mt-8 text-left w-full">
              <summary className="cursor-pointer text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors">
                Response Details
              </summary>
              <div className="mt-3 p-4 bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg overflow-auto">
                <pre className="text-xs text-bolt-elements-textSecondary font-mono whitespace-pre-wrap break-words">
                  {JSON.stringify({ status: error.status, statusText: error.statusText, data: error.data }, null, 2)}
                </pre>
              </div>
            </details>
          )}
        </div>
      </div>
    );
  }

  const errorName = error instanceof Error ? error.name : 'Error';
  const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
  const errorStack = error instanceof Error ? error.stack : undefined;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary px-6">
      <div className="max-w-lg w-full text-center">
        <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-6">
          <div className="i-ph:warning-circle-duotone text-3xl text-red-400" />
        </div>
        <h1 className="text-2xl font-bold mb-2">Unexpected Error</h1>
        <p className="text-sm text-bolt-elements-textSecondary mb-2">
          {import.meta.env.PROD ? 'An unexpected error occurred.' : errorMessage}
        </p>
        <p className="text-xs text-bolt-elements-textTertiary mb-8">
          {import.meta.env.PROD
            ? 'Please try again or reload the page.'
            : 'Something went wrong while rendering this page. Check the details below for debugging info.'}
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => window.history.back()}
            className="px-5 py-2.5 rounded-lg text-sm font-medium border border-bolt-elements-borderColor bg-transparent text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2 transition-colors duration-200"
          >
            Go Back
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 rounded-lg text-sm font-medium bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover transition-colors duration-200"
          >
            Reload Page
          </button>
        </div>
        {!import.meta.env.PROD && (
          <details className="mt-8 text-left w-full" open>
            <summary className="cursor-pointer text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors">
              Error Details
            </summary>
            <div className="mt-3 p-4 bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg overflow-auto max-h-80">
              <p className="text-xs text-red-400 font-mono font-semibold mb-2">
                {errorName}: {errorMessage}
              </p>
              {errorStack && (
                <pre className="text-xs text-bolt-elements-textTertiary font-mono whitespace-pre-wrap break-words">
                  {errorStack}
                </pre>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

export { SentryErrorBoundary as ErrorBoundary };

function App() {
  const theme = useStore(themeStore);

  useEffect(() => {
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('Unhandled promise rejection:', event.reason);
    };

    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => window.removeEventListener('unhandledrejection', onUnhandledRejection);
  }, []);

  useEffect(() => {
    logStore.logSystem('Application initialized', {
      theme,
      platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    });

    // Initialize debug logging with improved error handling
    import('./utils/debugLogger')
      .then(({ debugLogger }) => {
        /*
         * The debug logger initializes itself and starts disabled by default
         * It will only start capturing when enableDebugMode() is called
         */
        const status = debugLogger.getStatus();
        logStore.logSystem('Debug logging ready', {
          initialized: status.initialized,
          capturing: status.capturing,
          enabled: status.enabled,
        });
      })
      .catch((error) => {
        logStore.logError('Failed to initialize debug logging', error);
      });
  }, []);

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-accent-500 focus:text-white focus:rounded-lg"
      >
        Skip to content
      </a>
      <Sentry.ErrorBoundary
        showDialog={false}
        onError={(error) => {
          const err = error instanceof Error ? error : new Error(String(error));
          console.error('[Bolt:AppError]', {
            timestamp: new Date().toISOString(),
            name: err.name,
            message: err.message,
            stack: err.stack,
          });
        }}
        fallback={({ error, resetError }) => (
          <div className="flex flex-col items-center justify-center min-h-screen bg-bolt-elements-background-depth-1 text-center px-6">
            <div className="max-w-lg w-full">
              <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-6">
                <div className="i-ph:warning-circle-duotone text-3xl text-red-400" />
              </div>
              <h3 className="text-xl font-semibold text-bolt-elements-textPrimary mb-2">Application Error</h3>
              <p className="text-sm text-bolt-elements-textSecondary mb-6">
                An unexpected error occurred in the application. You can try again or reload the page.
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={resetError}
                  className="px-5 py-2.5 rounded-lg text-sm font-medium bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover transition-colors duration-200"
                >
                  Try Again
                </button>
                <button
                  onClick={() => window.location.reload()}
                  className="px-5 py-2.5 rounded-lg text-sm font-medium border border-bolt-elements-borderColor bg-transparent text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2 transition-colors duration-200"
                >
                  Reload Page
                </button>
              </div>
              {!import.meta.env.PROD && error instanceof Error && (
                <details className="mt-8 w-full text-left" open>
                  <summary className="cursor-pointer text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors">
                    Error Details
                  </summary>
                  <div className="mt-3 p-4 bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg overflow-auto max-h-80">
                    <p className="text-xs text-red-400 font-mono font-semibold mb-2">
                      {error.name}: {error.message}
                    </p>
                    {error.stack && (
                      <pre className="text-xs text-bolt-elements-textTertiary font-mono whitespace-pre-wrap break-words">
                        {error.stack}
                      </pre>
                    )}
                  </div>
                </details>
              )}
            </div>
          </div>
        )}
      >
        <Outlet />
      </Sentry.ErrorBoundary>
    </>
  );
}

export default App;
