import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { IconButton } from '~/components/ui/IconButton';

/**
 * Built-in browser view (next to Code / Preview). Unlike Preview, which is
 * bound to the dev-server of the running project, this is a free-navigation
 * embedded browser for docs, references, and testing external URLs.
 */

const QUICK_LINKS: Array<{ label: string; url: string; icon: string }> = [
  { label: 'MDN Web Docs', url: 'https://developer.mozilla.org', icon: 'i-ph:file-doc' },
  { label: 'React', url: 'https://react.dev', icon: 'i-ph:atom' },
  { label: 'Tailwind CSS', url: 'https://tailwindcss.com/docs', icon: 'i-ph:paint-brush' },
  { label: 'npm', url: 'https://www.npmjs.com', icon: 'i-ph:package' },
  { label: 'Can I Use', url: 'https://caniuse.com', icon: 'i-ph:check-square' },
  { label: 'DevDocs', url: 'https://devdocs.io', icon: 'i-ph:books' },
];

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

  // Anything else becomes a DuckDuckGo search (no API key, embeds cleanly)
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

export const BrowserPanel = memo(() => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [inputValue, setInputValue] = useState('');
  const [currentUrl, setCurrentUrl] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex >= 0 && historyIndex < history.length - 1;

  const navigateTo = useCallback(
    (url: string, { recordHistory = true }: { recordHistory?: boolean } = {}) => {
      setCurrentUrl(url);
      setInputValue(url);
      setIsLoading(true);

      if (recordHistory) {
        setHistory((prev) => {
          const next = [...prev.slice(0, historyIndex + 1), url];
          setHistoryIndex(next.length - 1);

          return next;
        });
      }
    },
    [historyIndex],
  );

  const goBack = useCallback(() => {
    if (!canGoBack) {
      return;
    }

    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    navigateTo(history[nextIndex], { recordHistory: false });
  }, [canGoBack, history, historyIndex, navigateTo]);

  const goForward = useCallback(() => {
    if (!canGoForward) {
      return;
    }

    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    navigateTo(history[nextIndex], { recordHistory: false });
  }, [canGoForward, history, historyIndex, navigateTo]);

  const reload = useCallback(() => {
    if (iframeRef.current && currentUrl) {
      setIsLoading(true);
      iframeRef.current.src = currentUrl;
    }
  }, [currentUrl]);

  const onSubmit = useCallback(() => {
    const url = normalizeUrl(inputValue);

    if (url) {
      navigateTo(url);
    }
  }, [inputValue, navigateTo]);

  const openInNewTab = useCallback(() => {
    if (currentUrl) {
      window.open(currentUrl, '_blank', 'noopener,noreferrer');
    }
  }, [currentUrl]);

  const quickLinks = useMemo(() => QUICK_LINKS, []);

  return (
    <div className="w-full h-full flex flex-col bg-devonz-elements-background-depth-1">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-devonz-elements-borderColor bg-devonz-elements-background-depth-2">
        <IconButton icon="i-ph:caret-left" aria-label="Go back" disabled={!canGoBack} onClick={goBack} />
        <IconButton icon="i-ph:caret-right" aria-label="Go forward" disabled={!canGoForward} onClick={goForward} />
        <IconButton icon="i-ph:arrow-clockwise" aria-label="Reload page" disabled={!currentUrl} onClick={reload} />

        <div className="flex-grow flex items-center gap-2 bg-devonz-elements-background-depth-1 border border-devonz-elements-borderColor rounded-md px-2.5 py-1 text-sm focus-within:border-accent-500/60 transition-colors">
          <span
            className={
              isLoading
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
      <div className="flex-1 relative">
        {currentUrl ? (
          <iframe
            ref={iframeRef}
            title="Built-in browser"
            className="border-none w-full h-full bg-white"
            src={currentUrl}
            onLoad={() => setIsLoading(false)}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-same-origin allow-downloads"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-6 text-devonz-elements-textSecondary">
            <div className="flex flex-col items-center gap-2">
              <span className="i-ph:globe-hemisphere-west text-5xl text-devonz-elements-textTertiary" />
              <p className="text-sm">Browse documentation and references without leaving the workbench</p>
              <p className="text-xs text-devonz-elements-textTertiary">
                Note: some sites block embedding and will only open in a new tab
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {quickLinks.map((link) => (
                <button
                  key={link.url}
                  onClick={() => navigateTo(link.url)}
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
