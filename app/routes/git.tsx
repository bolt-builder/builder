import { Suspense, useEffect } from 'react';
import { type LoaderFunctionArgs, type MetaFunction, useRouteError, isRouteErrorResponse } from 'react-router';
import { BaseChat } from '~/components/chat/BaseChat';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { clientLazy } from '~/utils/react';

const GitUrlImport = clientLazy(() =>
  import('~/components/git/GitUrlImport.client').then((m) => ({ default: m.GitUrlImport })),
);

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

export async function loader(args: LoaderFunctionArgs) {
  return Response.json({ url: args.params.url });
}

export default function Index() {
  return (
    <main className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <Suspense fallback={<BaseChat />}>
        <GitUrlImport />
      </Suspense>
    </main>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  useEffect(() => {
    console.error('[Bolt:GitRouteError]', {
      timestamp: new Date().toISOString(),
      route: 'git',
      ...(isRouteErrorResponse(error)
        ? { status: error.status, statusText: error.statusText, data: error.data }
        : error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { raw: String(error) }),
    });
  }, [error]);

  const message = isRouteErrorResponse(error)
    ? error.data || 'Failed to load the Git import page.'
    : error instanceof Error
      ? error.message
      : 'An unexpected error occurred while loading the Git import.';

  return (
    <main className="flex flex-col items-center justify-center h-full w-full bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary px-6">
      <div className="max-w-lg w-full text-center">
        <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-6">
          <div className="i-ph:git-branch text-3xl text-red-400" />
        </div>
        <h1 className="text-2xl font-bold mb-2">Git Import Error</h1>
        <p className="text-sm text-bolt-elements-textSecondary mb-8">{message}</p>
        <div className="flex gap-3 justify-center">
          <a
            href="/"
            className="px-5 py-2.5 rounded-lg text-sm font-medium border border-bolt-elements-borderColor bg-transparent text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2 transition-colors duration-200"
          >
            Go Home
          </a>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 rounded-lg text-sm font-medium bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover transition-colors duration-200"
          >
            Reload
          </button>
        </div>
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
