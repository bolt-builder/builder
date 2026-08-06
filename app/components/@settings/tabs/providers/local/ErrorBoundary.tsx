import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('LocalProvidersErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('Caught error:', error, errorInfo);
    console.error('[Bolt:LocalProvidersError]', {
      timestamp: new Date().toISOString(),
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const { error } = this.state;

      return (
        <div className="flex flex-col items-center justify-center p-6 text-center bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor rounded-lg">
          <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center mb-5">
            <div className="i-ph:warning-circle-duotone text-2xl text-red-400" />
          </div>
          <h3 className="text-lg font-semibold text-bolt-elements-textPrimary mb-1.5">Something went wrong</h3>
          <p className="text-sm text-bolt-elements-textSecondary mb-5 max-w-sm">
            There was an error loading the local providers section.
          </p>
          <div className="flex gap-2.5 mb-5">
            <button
              onClick={() => this.setState({ hasError: false, error: undefined })}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover transition-colors duration-200"
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="i-ph:arrow-counter-clockwise text-xs" />
                Try Again
              </span>
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-bolt-elements-borderColor bg-transparent text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2 transition-colors duration-200"
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="i-ph:arrow-clockwise text-xs" />
                Reload Page
              </span>
            </button>
          </div>
          {!import.meta.env.PROD && error && (
            <details className="w-full max-w-md text-left">
              <summary className="cursor-pointer text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors">
                Error Details
              </summary>
              <div className="mt-2 p-3 bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg overflow-auto max-h-48">
                <p className="text-xs text-red-400 font-mono font-semibold mb-1.5">
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
      );
    }

    return this.props.children;
  }
}
