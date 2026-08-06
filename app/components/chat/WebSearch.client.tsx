import { useState, useRef, useEffect } from 'react';
import { IconButton } from '~/components/ui/IconButton';
import { toast } from 'sonner';
import { cn } from '~/utils/cn';
import { csrfFetch } from '~/lib/api/csrf-client';

interface WebSearchProps {
  onSearchResult: (result: string) => void;
  disabled?: boolean;
}

interface WebSearchData {
  title: string;
  description: string;
  content: string;
  sourceUrl: string;
}

interface WebSearchResponse {
  success?: boolean;
  data?: WebSearchData;
  error?: { message: string; name: string; type?: string };
  message?: string;
}

function formatSearchResult(data: WebSearchData): string {
  const parts: string[] = [];

  parts.push(`[Source: ${data.sourceUrl}]`);

  if (data.title) {
    parts.push(`Title: ${data.title}`);
  }

  if (data.description) {
    parts.push(`Description: ${data.description}`);
  }

  parts.push(`\nContent:\n${data.content}`);

  return parts.join('\n');
}

export function WebSearch({ onSearchResult, disabled }: WebSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleFetch = async () => {
    const trimmedUrl = url.trim();

    if (!trimmedUrl) {
      return;
    }

    setIsSearching(true);

    try {
      const response = await csrfFetch('/api/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmedUrl }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = (await response.json()) as WebSearchResponse;

      if (result.success && result.data) {
        const formatted = formatSearchResult(result.data);
        onSearchResult(formatted);
        setUrl('');
        setIsOpen(false);
        toast.success('URL content fetched successfully');
      } else {
        toast.error(result.message || result.error?.message || 'Failed to fetch URL');
      }
    } catch {
      toast.error('Failed to fetch URL');
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <IconButton
        title="Fetch URL content"
        disabled={disabled || isSearching}
        onClick={() => setIsOpen(!isOpen)}
        className="transition-all"
      >
        {isSearching ? (
          <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress text-xl animate-spin" />
        ) : (
          <div className="i-ph:globe text-xl" />
        )}
      </IconButton>
      {isOpen && (
        <div
          className={cn(
            'absolute bottom-full left-0 mb-2 flex items-center gap-2',
            'rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-2 shadow-lg',
          )}
        >
          <input
            ref={inputRef}
            type="url"
            autoComplete="url"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && url.trim()) {
                handleFetch();
              }

              if (e.key === 'Escape') {
                setIsOpen(false);
              }
            }}
            placeholder="Enter URL to fetch..."
            aria-label="URL to fetch"
            className={cn(
              'w-64 px-3 py-1.5 rounded-md text-sm',
              'bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary',
              'placeholder-bolt-elements-textTertiary',
              'focus:outline-none focus:ring-2 focus:ring-bolt-elements-focus',
            )}
          />
          <button
            onClick={handleFetch}
            disabled={isSearching || !url.trim()}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap',
              'bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text',
              'hover:bg-bolt-elements-button-primary-backgroundHover',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {isSearching ? 'Fetching...' : 'Fetch'}
          </button>
        </div>
      )}
    </div>
  );
}
