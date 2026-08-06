import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { Button } from '~/components/ui/Button';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('GitHubErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class GitHubErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('Caught error:', error, errorInfo);
    console.error('[Bolt:GitHubError]', {
      timestamp: new Date().toISOString(),
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });

    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const { error } = this.state;

      return (
        <div className="flex flex-col items-center justify-center p-8 text-center bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor rounded-lg">
          <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center mb-5">
            <div className="i-ph:github-logo text-2xl text-red-400" />
          </div>

          <h3 className="text-lg font-semibold text-bolt-elements-textPrimary mb-1.5">GitHub Integration Error</h3>
          <p className="text-sm text-bolt-elements-textSecondary mb-5 max-w-sm">
            Something went wrong while loading GitHub data. This could be due to network issues, API rate limits, or a
            temporary problem.
          </p>

          <div className="flex gap-2.5 mb-5">
            <Button variant="default" size="sm" onClick={this.handleRetry}>
              <span className="i-ph:arrow-counter-clockwise mr-1.5 text-xs" />
              Try Again
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              <span className="i-ph:arrow-clockwise mr-1.5 text-xs" />
              Reload Page
            </Button>
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
