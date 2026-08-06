import { useState, useMemo, useCallback, useEffect, memo } from 'react';
import { workbenchStore } from '~/lib/stores/workbench';
import { debounce } from '~/utils/debounce';
import { createScopedLogger } from '~/utils/logger';
import { csrfFetch } from '~/lib/api/csrf-client';

const logger = createScopedLogger('Search');

interface DisplayMatch {
  path: string;
  lineNumber: number;
  previewText: string;
  matchCharStart: number;
  matchCharEnd: number;
}

/**
 * Search project files via the server-side search API.
 *
 * Replaces the WebContainer `internal.textSearch()` private API with
 * a POST request to `/api/runtime/search`.
 */
async function performTextSearch(
  projectId: string,
  query: string,
  options: {
    includes?: string[];
    excludes?: string[];
    caseSensitive?: boolean;
    isRegex?: boolean;
    isWordMatch?: boolean;
    resultLimit?: number;
  },
): Promise<DisplayMatch[]> {
  const response = await csrfFetch('/api/runtime/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      query,
      ...options,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(errorBody.message ?? errorBody.error?.message ?? `Search failed with status ${response.status}`);
  }

  const envelope = await response.json();

  return envelope.data.results as DisplayMatch[];
}

function groupResultsByFile(results: DisplayMatch[]): Record<string, DisplayMatch[]> {
  return results.reduce(
    (acc, result) => {
      if (!acc[result.path]) {
        acc[result.path] = [];
      }

      acc[result.path].push(result);

      return acc;
    },
    {} as Record<string, DisplayMatch[]>,
  );
}

export const Search = memo(() => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DisplayMatch[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [hasSearched, setHasSearched] = useState(false);

  const groupedResults = useMemo(() => groupResultsByFile(searchResults), [searchResults]);

  useEffect(() => {
    if (searchResults.length > 0) {
      const allExpanded: Record<string, boolean> = {};
      Object.keys(groupedResults).forEach((file) => {
        allExpanded[file] = true;
      });
      setExpandedFiles(allExpanded);
    }
  }, [groupedResults, searchResults]);

  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      setExpandedFiles({});
      setHasSearched(false);

      return;
    }

    setIsSearching(true);
    setSearchResults([]);
    setExpandedFiles({});
    setHasSearched(true);

    const minLoaderTime = 300; // ms
    const start = Date.now();

    try {
      const results = await performTextSearch('default', query, {
        includes: ['**/*.*'],
        excludes: ['**/node_modules/**', '**/package-lock.json', '**/.git/**', '**/dist/**', '**/*.lock'],
        resultLimit: 500,
        isRegex: false,
        caseSensitive: false,
        isWordMatch: false,
      });

      setSearchResults(results);
    } catch (error) {
      logger.error('Failed to initiate search:', error);
    } finally {
      const elapsed = Date.now() - start;

      if (elapsed < minLoaderTime) {
        setTimeout(() => setIsSearching(false), minLoaderTime - elapsed);
      } else {
        setIsSearching(false);
      }
    }
  }, []);

  const debouncedSearch = useMemo(() => debounce(handleSearch, 300), [handleSearch]);

  useEffect(() => {
    debouncedSearch(searchQuery);
  }, [searchQuery, debouncedSearch]);

  // Cancel pending debounced search on unmount
  useEffect(() => {
    return () => debouncedSearch.cancel();
  }, [debouncedSearch]);

  const handleResultClick = (filePath: string, line?: number) => {
    workbenchStore.setSelectedFile(filePath);

    /*
     * Adjust line number to be 0-based if it's defined
     * The search results use 1-based line numbers, but CodeMirrorEditor expects 0-based
     */
    const adjustedLine = typeof line === 'number' ? Math.max(0, line - 1) : undefined;

    workbenchStore.setCurrentDocumentScrollPosition({ line: adjustedLine, column: 0 });
  };

  return (
    <div className="flex flex-col h-full bg-bolt-elements-background-depth-2">
      {/* Search Bar */}
      <div className="flex items-center py-3 px-3">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search project files"
            className="w-full px-2 py-1 rounded-md bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-focus transition-all"
          />
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto py-2">
        {isSearching && (
          <div className="flex items-center justify-center h-32 text-bolt-elements-textTertiary">
            <div className="i-ph:circle-notch animate-spin mr-2" /> Searching...
          </div>
        )}
        {!isSearching && hasSearched && searchResults.length === 0 && searchQuery.trim() !== '' && (
          <div className="flex items-center justify-center h-32 text-gray-500">No results found.</div>
        )}
        {!isSearching &&
          Object.keys(groupedResults).map((file) => (
            <div key={file} className="mb-2">
              <button
                className="flex gap-2 items-center w-full text-left py-1 px-2 text-bolt-elements-textSecondary bg-transparent hover:bg-bolt-elements-background-depth-3 group"
                onClick={() => setExpandedFiles((prev) => ({ ...prev, [file]: !prev[file] }))}
                aria-expanded={!!expandedFiles[file]}
                aria-label={`${expandedFiles[file] ? 'Collapse' : 'Expand'} results for ${file.split('/').pop()}`}
              >
                <span
                  className=" i-ph:caret-down-thin w-3 h-3 text-bolt-elements-textSecondary transition-transform"
                  style={{ transform: expandedFiles[file] ? 'rotate(180deg)' : undefined }}
                />
                <span className="font-normal text-sm">{file.split('/').pop()}</span>
                <span className="h-5.5 w-5.5 flex items-center justify-center text-xs ml-auto bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent rounded-full">
                  {groupedResults[file].length}
                </span>
              </button>
              {expandedFiles[file] && (
                <div className="">
                  {groupedResults[file].map((match, idx) => {
                    const contextChars = 7;
                    const isStart = match.matchCharStart <= contextChars;
                    const previewStart = isStart ? 0 : match.matchCharStart - contextChars;
                    const previewText = match.previewText.slice(previewStart);
                    const matchStart = isStart ? match.matchCharStart : contextChars;
                    const matchEnd = isStart
                      ? match.matchCharEnd
                      : contextChars + (match.matchCharEnd - match.matchCharStart);

                    return (
                      <div
                        key={idx}
                        role="button"
                        tabIndex={0}
                        className="hover:bg-bolt-elements-background-depth-3 cursor-pointer transition-colors pl-6 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-focus"
                        onClick={() => handleResultClick(match.path, match.lineNumber)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleResultClick(match.path, match.lineNumber);
                          }
                        }}
                      >
                        <pre className="font-mono text-xs text-bolt-elements-textTertiary truncate">
                          {!isStart && <span>...</span>}
                          {previewText.slice(0, matchStart)}
                          <span className="bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent rounded px-1">
                            {previewText.slice(matchStart, matchEnd)}
                          </span>
                          {previewText.slice(matchEnd)}
                        </pre>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
});
