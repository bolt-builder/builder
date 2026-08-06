import { lazy, Suspense, useEffect } from 'react';
import { type MetaFunction, useRouteError, isRouteErrorResponse } from 'react-router';
import { BaseChat } from '~/components/chat/BaseChat';
import { ComponentErrorBoundary } from '~/components/ui/ComponentErrorBoundary';
import { Header } from '~/components/header/Header';
import { clientLazy } from '~/utils/react';

const Chat = clientLazy(() => import('~/components/chat/Chat.client').then((m) => ({ default: m.Chat })));
const MigrationBanner = clientLazy(() =>
  import('~/components/chat/MigrationBanner.client').then((m) => ({ default: m.MigrationBanner })),
);
const UpdateBanner = lazy(() => import('~/components/ui/UpdateBanner').then((m) => ({ default: m.UpdateBanner })));

export const meta: MetaFunction = () => {
  return [
    { title: 'Bolt' },
    { name: 'description', content: 'Talk with Bolt, an AI-powered development assistant' },
    { property: 'og:title', content: 'Bolt' },
    { property: 'og:description', content: 'Talk with Bolt, an AI-powered development assistant' },
    { property: 'og:type', content: 'website' },
    { property: 'og:image', content: '/logo-dark-styled.png' },
    { name: 'twitter:card', content: 'summary' },
    { name: 'twitter:title', content: 'Bolt' },
    { name: 'twitter:description', content: 'Talk with Bolt, an AI-powered development assistant' },
  ];
};

export const loader = () => Response.json({});

export function ErrorBoundary() {
  const error = useRouteError();

  useEffect(() => {
    console.error('[Bolt:IndexRouteError]', {
      timestamp: new Date().toISOString(),
      route: '_index',
      ...(isRouteErrorResponse(error)
        ? { status: error.status, statusText: error.statusText, data: error.data }
        : error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { raw: String(error) }),
    });
  }, [error]);

  const message = isRouteErrorResponse(error)
    ? error.data || 'Failed to load the page.'
    : error instanceof Error
      ? error.message
      : 'An unexpected error occurred.';

  return (
    <main className="flex flex-col items-center justify-center h-full w-full bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary px-6">
      <div className="max-w-lg w-full text-center">
        <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-6">
          <div className="i-ph:warning-circle-duotone text-3xl text-red-400" />
        </div>
        <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
        <p className="text-sm text-bolt-elements-textSecondary mb-8">{message}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-5 py-2.5 rounded-lg text-sm font-medium bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover transition-colors duration-200"
        >
          Reload Page
        </button>
        {error instanceof Error && error.stack && (
          <details className="mt-8 text-left w-full">
            <summary className="cursor-pointer text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors">
              Error Details
            </summary>
            <div className="mt-3 p-4 bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg overflow-auto max-h-64">
              <p className="text-xs text-red-400 font-mono font-semibold mb-2">
                {error.name}: {error.message}
              </p>
              <pre className="text-xs text-bolt-elements-textTertiary font-mono whitespace-pre-wrap break-words">
                {error.stack}
              </pre>
            </div>
          </details>
        )}
      </div>
    </main>
  );
}

/**
 * Landing page component for Bolt
 * Note: Settings functionality should ONLY be accessed through the sidebar menu.
 * Do not add settings button/panel to this landing page as it was intentionally removed
 * to keep the UI clean and consistent with the design system.
 */
export default function Index() {
  return (
    <main id="main-content" className="flex flex-col h-full w-full overflow-hidden bg-bolt-elements-background-depth-1">
      <Suspense fallback={null}>
        <MigrationBanner />
      </Suspense>
      <Suspense fallback={null}>
        <UpdateBanner />
      </Suspense>
      <Header />
      <ComponentErrorBoundary name="Chat">
        <Suspense fallback={<BaseChat />}>
          <Chat />
        </Suspense>
      </ComponentErrorBoundary>
    </main>
  );
}
