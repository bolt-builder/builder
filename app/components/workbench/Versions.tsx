import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { useStore } from '@nanostores/react';
import { runtimeContext } from '~/lib/runtime';
import {
  type GitCommitInfo,
  type FileChange,
  getLog,
  checkout,
  checkoutMain,
  getCommitFilesWithStatus,
  getFileDiff,
  downloadArchive,
} from '~/lib/runtime/git-client';
import { versionsStore } from '~/lib/stores/versions';
import { Markdown } from '~/components/chat/Markdown';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('Versions');

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) {
    return 'Just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${days}d ago`;
}

interface CommitCardProps {
  commit: GitCommitInfo;
  isLatest: boolean;
  isCheckedOut: boolean;
  onRestore: (sha: string) => void;
  onViewFiles: (sha: string) => void;
  onImageClick?: (imageUrl: string) => void;
  onFork?: (sha: string) => void;
  onDownload?: (sha: string, type: 'full' | 'changed') => void;
  thumbnail?: string;
  totalTokens?: number;
  chatSummary?: string;
  isExpanded: boolean;
  onToggleExpand: (sha: string) => void;
}

function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

const CommitCard = memo(
  ({
    commit,
    isLatest,
    isCheckedOut,
    onRestore,
    onViewFiles,
    onImageClick,
    onFork,
    onDownload,
    thumbnail,
    totalTokens,
    chatSummary,
    isExpanded,
    onToggleExpand,
  }: CommitCardProps) => {
    const [isHovered, setIsHovered] = useState(false);

    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="rounded-xl transition-all"
        style={{
          background: isCheckedOut
            ? 'var(--bolt-elements-button-primary-background)'
            : isHovered
              ? 'var(--bolt-elements-bg-depth-4)'
              : 'transparent',
          opacity: isCheckedOut ? 0.95 : 1,
          borderBottom: '1px solid var(--bolt-elements-borderColor)',
          borderLeft: isHovered ? '2px solid var(--bolt-elements-button-primary-background)' : '2px solid transparent',
        }}
      >
        {/* Main card row */}
        <div
          className="flex gap-3 p-3 cursor-pointer"
          onClick={() => onToggleExpand(commit.sha)}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          aria-label={`Toggle details for commit ${commit.shortSha}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleExpand(commit.sha);
            }
          }}
        >
          {/* Thumbnail — fills card height */}
          <div className="flex-shrink-0 self-stretch" style={{ width: '140px', minHeight: '80px' }}>
            {thumbnail ? (
              <img
                src={thumbnail}
                alt={`Preview for ${commit.shortSha}`}
                className="rounded-md object-contain w-full h-full cursor-zoom-in"
                style={{
                  border: '1px solid var(--bolt-elements-borderColor)',
                  background: 'var(--bolt-elements-bg-depth-3)',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onImageClick?.(thumbnail);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onImageClick?.(thumbnail);
                  }
                }}
              />
            ) : (
              <div
                className="rounded-md flex items-center justify-center w-full h-full"
                style={{
                  background: 'var(--bolt-elements-bg-depth-3)',
                  border: '1px solid var(--bolt-elements-borderColor)',
                  minHeight: '36px',
                }}
              >
                <div className="i-ph:image text-base" style={{ color: 'var(--bolt-elements-textTertiary)' }} />
              </div>
            )}
          </div>

          {/* Commit info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="px-1.5 py-0.5 rounded text-xs font-mono"
                style={{
                  background: 'var(--bolt-elements-button-secondary-background)',
                  color: 'var(--bolt-elements-textSecondary)',
                }}
              >
                {commit.shortSha}
              </span>

              {isLatest && (
                <span
                  className="px-2 py-0.5 rounded text-xs font-medium"
                  style={{
                    background: 'var(--bolt-elements-button-primary-background)',
                    color: 'var(--bolt-elements-button-primary-text)',
                  }}
                >
                  Latest
                </span>
              )}

              {isCheckedOut && !isLatest && (
                <span
                  className="px-2 py-0.5 rounded text-xs font-medium"
                  style={{
                    background: 'var(--bolt-elements-item-backgroundAccent)',
                    color: 'var(--bolt-elements-item-contentAccent)',
                  }}
                >
                  Active
                </span>
              )}

              {/* Actions */}
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewFiles(commit.sha);
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors"
                  style={{
                    background: 'var(--bolt-elements-button-secondary-background)',
                    color: 'var(--bolt-elements-textSecondary)',
                  }}
                  title="View changed files"
                >
                  <div className="i-ph:files text-xs" />
                </button>
                {onFork && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onFork(commit.sha);
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors"
                    style={{
                      background: 'var(--bolt-elements-button-secondary-background)',
                      color: 'var(--bolt-elements-textSecondary)',
                    }}
                    title="Fork from this version"
                  >
                    <div className="i-ph:git-fork text-xs" />
                  </button>
                )}
                {onDownload && (
                  <div className="relative group">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDownload(commit.sha, 'full');
                      }}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors"
                      style={{
                        background: 'var(--bolt-elements-button-secondary-background)',
                        color: 'var(--bolt-elements-textSecondary)',
                      }}
                      title="Download project at this version"
                    >
                      <div className="i-ph:download-simple text-xs" />
                    </button>
                  </div>
                )}
                {!isLatest && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRestore(commit.sha);
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors"
                    style={{
                      background: 'var(--bolt-elements-button-primary-background)',
                      color: 'var(--bolt-elements-button-primary-text)',
                    }}
                  >
                    <div className="i-ph:arrow-counter-clockwise text-xs" />
                    Restore
                  </button>
                )}
              </div>
            </div>

            <h3 className="text-sm font-medium text-bolt-elements-textPrimary truncate mb-0.5">{commit.message}</h3>

            <div className="flex items-center gap-1 text-xs text-bolt-elements-textTertiary">
              <div className="i-ph:clock text-xs" />
              <span>{formatRelativeTime(commit.timestamp)}</span>
              {totalTokens != null && totalTokens > 0 && (
                <>
                  <span>•</span>
                  <div className="i-ph:coins text-xs" />
                  <span>{formatTokenCount(totalTokens)} tokens</span>
                </>
              )}
              {(commit.additions > 0 || commit.deletions > 0) && (
                <>
                  <span>•</span>
                  {commit.additions > 0 && <span style={{ color: '#4ade80' }}>+{commit.additions}</span>}
                  {commit.deletions > 0 && <span style={{ color: '#f87171' }}>-{commit.deletions}</span>}
                </>
              )}
              {/* Expand chevron */}
              <motion.div
                className="i-ph:caret-down text-xs ml-auto"
                style={{ color: 'var(--bolt-elements-textTertiary)' }}
                animate={{ rotate: isExpanded ? 180 : 0 }}
                transition={{ duration: 0.2 }}
              />
            </div>
          </div>
        </div>

        {/* Expandable detail section */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div
                className="px-3 pb-3 pt-1 text-xs"
                style={{ borderTop: '1px solid var(--bolt-elements-borderColor)' }}
              >
                {chatSummary && (
                  <div className="mb-2">
                    <div className="font-medium text-bolt-elements-textSecondary mb-1">Summary</div>
                    <div className="text-bolt-elements-textTertiary prose-sm max-w-none">
                      <Markdown>{chatSummary}</Markdown>
                    </div>
                  </div>
                )}
                {totalTokens != null && totalTokens > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-bolt-elements-textSecondary">Tokens:</span>
                    <span className="font-mono text-bolt-elements-textTertiary">{totalTokens.toLocaleString()}</span>
                  </div>
                )}
                {!chatSummary && (totalTokens == null || totalTokens === 0) && (
                  <div className="text-bolt-elements-textTertiary italic">No additional details available.</div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    );
  },
);

export const Versions = memo(() => {
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [checkedOutSha, setCheckedOutSha] = useState<string | null>(null);
  const [filesModal, setFilesModal] = useState<{
    sha: string;
    files: FileChange[];
    diffs: Map<string, string>;
  } | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState<string | null>(null);
  const [diffModalContent, setDiffModalContent] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [expandedSha, setExpandedSha] = useState<string | null>(null);

  const versionsMap = useStore(versionsStore.versions);
  const lastCommitTs = useStore(versionsStore.lastCommitTimestamp);

  const thumbnailsBySha = useMemo(() => {
    const thumbMap = new Map<string, string>();

    for (const version of Object.values(versionsMap)) {
      if (version.commitSha && version.thumbnail) {
        thumbMap.set(version.commitSha, version.thumbnail);
      }
    }

    return thumbMap;
  }, [versionsMap]);

  /** Map commit SHA → version metadata (totalTokens, chatSummary) */
  const versionMetaBySha = useMemo(() => {
    const metaMap = new Map<string, { totalTokens?: number; chatSummary?: string }>();

    for (const version of Object.values(versionsMap)) {
      if (version.commitSha) {
        metaMap.set(version.commitSha, {
          totalTokens: version.totalTokens,
          chatSummary: version.chatSummary,
        });
      }
    }

    return metaMap;
  }, [versionsMap]);

  const loadCommits = useCallback(async () => {
    // Read projectId at call time (not render time) since runtimeContext is non-reactive
    const currentProjectId = runtimeContext.projectId;

    if (!currentProjectId) {
      setLoading(false);
      return;
    }

    setLoading(true);

    const log = await getLog(currentProjectId);
    setCommits(log);

    // Try to backfill any missing thumbnails now that the panel is visible
    versionsStore.backfillMissingThumbnails();

    setLoading(false);
  }, []);

  useEffect(() => {
    /*
     * runtimeContext is a plain object (not reactive), so projectId may still be
     * null when the component mounts.  Poll briefly until bootRuntime completes.
     */
    if (runtimeContext.projectId) {
      loadCommits();
      return undefined;
    }

    const interval = setInterval(() => {
      if (runtimeContext.projectId) {
        clearInterval(interval);
        loadCommits();
      }
    }, 250);

    return () => {
      clearInterval(interval);
    };
  }, [loadCommits]);

  // Auto-refresh when a new commit SHA is stored
  useEffect(() => {
    if (lastCommitTs > 0) {
      loadCommits();
    }
  }, [lastCommitTs, loadCommits]);

  const handleRestore = useCallback(
    async (sha: string) => {
      // Read projectId at call time since runtimeContext is non-reactive
      const currentProjectId = runtimeContext.projectId;

      if (!currentProjectId || restoring) {
        return;
      }

      setRestoring(true);

      try {
        const success = await checkout(currentProjectId, sha);

        if (success) {
          setCheckedOutSha(sha);
          toast.success('Restored to previous version. Files will update shortly.');

          /*
           * The file watcher will pick up changes from git checkout,
           * but give it a moment then force a reload of the commit list.
           */
          setTimeout(() => loadCommits(), 1000);
        } else {
          toast.error('Failed to restore version');
        }
      } catch (error) {
        logger.error('Restore failed:', error);
        toast.error('Failed to restore version');
      } finally {
        setRestoring(false);
      }
    },
    [restoring, loadCommits],
  );

  const handleReturnToLatest = useCallback(async () => {
    // Read projectId at call time since runtimeContext is non-reactive
    const currentProjectId = runtimeContext.projectId;

    if (!currentProjectId || restoring) {
      return;
    }

    setRestoring(true);

    try {
      const success = await checkoutMain(currentProjectId);

      if (success) {
        setCheckedOutSha(null);
        toast.success('Returned to latest version');
        setTimeout(() => loadCommits(), 1000);
      } else {
        toast.error('Failed to return to latest');
      }
    } catch (error) {
      logger.error('Return to latest failed:', error);
      toast.error('Failed to return to latest');
    } finally {
      setRestoring(false);
    }
  }, [restoring, loadCommits]);

  const handleViewFiles = useCallback(async (sha: string) => {
    const currentProjectId = runtimeContext.projectId;

    if (!currentProjectId) {
      return;
    }

    const files = await getCommitFilesWithStatus(currentProjectId, sha);

    // Fetch all diffs in parallel
    const diffEntries = await Promise.all(
      files.map(async ({ file }) => {
        const diff = await getFileDiff(currentProjectId, sha, file);
        return [file, diff || '(no changes)'] as const;
      }),
    );

    setFilesModal({ sha, files, diffs: new Map(diffEntries) });
    setExpandedFiles(new Set());
  }, []);

  const handleDownload = useCallback(
    async (sha: string, type: 'full' | 'changed') => {
      const currentProjectId = runtimeContext.projectId;

      if (!currentProjectId || downloading) {
        return;
      }

      setDownloading(sha);

      try {
        await downloadArchive(currentProjectId, sha, type);
        toast.success(type === 'full' ? 'Project downloaded!' : 'Changed files downloaded!');
      } catch (error) {
        logger.error('Download failed:', error);
        toast.error('Download failed');
      } finally {
        setDownloading(null);
      }
    },
    [downloading],
  );

  const handleFork = useCallback(
    async (sha: string) => {
      const currentProjectId = runtimeContext.projectId;

      if (!currentProjectId || restoring) {
        return;
      }

      setRestoring(true);

      try {
        const success = await checkout(currentProjectId, sha);

        if (success) {
          setCheckedOutSha(sha);
          toast.success('Forked from this version. You can now build on top of it.');
          setTimeout(() => loadCommits(), 1000);
        } else {
          toast.error('Failed to fork version');
        }
      } catch (error) {
        logger.error('Fork failed:', error);
        toast.error('Failed to fork version');
      } finally {
        setRestoring(false);
      }
    },
    [restoring, loadCommits],
  );

  const handleToggleExpand = useCallback((sha: string) => {
    setExpandedSha((prev) => (prev === sha ? null : sha));
  }, []);

  const filteredCommits = commits.filter(
    (c) =>
      c.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.shortSha.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bolt-elements-bg-depth-1)' }}>
      {/* Header */}
      <div className="p-4 border-b border-bolt-elements-borderColor">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="i-ph:git-branch text-lg text-bolt-elements-textSecondary" />
            <h2 className="text-lg font-semibold text-bolt-elements-textPrimary">Git History</h2>
          </div>
          <div className="flex items-center gap-2">
            {checkedOutSha && (
              <button
                onClick={handleReturnToLatest}
                disabled={restoring}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs transition-colors"
                style={{
                  background: 'var(--bolt-elements-button-primary-background)',
                  color: 'var(--bolt-elements-button-primary-text)',
                }}
              >
                <div className="i-ph:arrow-up text-xs" />
                Return to Latest
              </button>
            )}
            <button
              onClick={loadCommits}
              disabled={loading}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors"
              style={{
                background: 'var(--bolt-elements-button-secondary-background)',
                color: 'var(--bolt-elements-textSecondary)',
              }}
              title="Refresh"
            >
              <div className={`i-ph:arrow-clockwise text-sm ${loading ? 'animate-spin' : ''}`} />
            </button>
            <span className="text-sm text-bolt-elements-textTertiary">{commits.length} commits</span>
          </div>
        </div>

        <p className="text-xs text-bolt-elements-textTertiary mb-3">
          Every AI response is automatically committed. Restore any previous version with one click.
        </p>

        {/* Search */}
        <div className="relative">
          <div className="i-ph:magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-bolt-elements-textTertiary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search commits..."
            className="w-full pl-9 pr-4 py-2 rounded-lg text-sm text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary outline-none"
            style={{
              background: 'var(--bolt-elements-button-secondary-background)',
              border: '1px solid var(--bolt-elements-borderColor)',
            }}
          />
        </div>
      </div>

      {/* Commits list */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="i-ph:spinner-gap-bold animate-spin text-2xl text-bolt-elements-textTertiary mb-2" />
            <span className="text-sm text-bolt-elements-textTertiary">Loading history...</span>
          </div>
        ) : filteredCommits.length > 0 ? (
          <AnimatePresence>
            {filteredCommits.map((commit, index) => {
              const meta = versionMetaBySha.get(commit.sha);

              return (
                <div key={commit.sha}>
                  <CommitCard
                    commit={commit}
                    isLatest={index === 0}
                    isCheckedOut={checkedOutSha === commit.sha}
                    onRestore={handleRestore}
                    onViewFiles={handleViewFiles}
                    onImageClick={setLightboxImage}
                    onFork={handleFork}
                    onDownload={handleDownload}
                    thumbnail={thumbnailsBySha.get(commit.sha)}
                    totalTokens={meta?.totalTokens}
                    chatSummary={meta?.chatSummary}
                    isExpanded={expandedSha === commit.sha}
                    onToggleExpand={handleToggleExpand}
                  />
                </div>
              );
            })}
          </AnimatePresence>
        ) : commits.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <div className="i-ph:git-commit text-4xl text-bolt-elements-textTertiary mb-4" />
            <h3 className="text-sm font-medium text-bolt-elements-textSecondary mb-1">No commits yet</h3>
            <p className="text-xs text-bolt-elements-textTertiary max-w-xs">
              Commits are created automatically after each AI response. Start a conversation to see history here.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <div className="i-ph:magnifying-glass text-4xl text-bolt-elements-textTertiary mb-4" />
            <h3 className="text-sm font-medium text-bolt-elements-textSecondary mb-1">No matches</h3>
            <p className="text-xs text-bolt-elements-textTertiary">No commits match &quot;{searchQuery}&quot;</p>
          </div>
        )}
      </div>

      {/* Lightbox overlay */}
      <AnimatePresence>
        {lightboxImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.85)' }}
            onClick={() => setLightboxImage(null)}
            role="dialog"
            aria-modal="true"
            aria-label="Image preview"
          >
            <motion.img
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              src={lightboxImage}
              alt="Full-size preview"
              className="rounded-xl"
              style={{
                maxWidth: '90vw',
                maxHeight: '90vh',
                objectFit: 'contain',
                border: '2px solid var(--bolt-elements-borderColor)',
              }}
              onClick={(e) => e.stopPropagation()}
            />
            <button
              onClick={() => setLightboxImage(null)}
              className="absolute top-6 right-6 flex items-center justify-center rounded-full transition-colors"
              style={{
                width: '36px',
                height: '36px',
                background: 'rgba(255, 255, 255, 0.15)',
                color: '#ffffff',
              }}
              aria-label="Close preview"
            >
              <div className="i-ph:x text-lg" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full Diff Modal */}
      <AnimatePresence>
        {diffModalContent && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.85)' }}
            onClick={() => setDiffModalContent(null)}
            role="dialog"
            aria-modal="true"
            aria-label="Full diff view"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="rounded-xl overflow-hidden flex flex-col"
              style={{
                width: '90vw',
                maxWidth: '1000px',
                maxHeight: '85vh',
                background: 'var(--bolt-elements-bg-depth-2)',
                border: '2px solid var(--bolt-elements-borderColor)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: '1px solid var(--bolt-elements-borderColor)' }}
              >
                <span className="text-sm font-medium text-bolt-elements-textPrimary">Full Diff</span>
                <button
                  onClick={() => setDiffModalContent(null)}
                  className="flex items-center justify-center rounded-full transition-colors"
                  style={{
                    width: '28px',
                    height: '28px',
                    background: 'var(--bolt-elements-button-secondary-background)',
                    color: 'var(--bolt-elements-textSecondary)',
                  }}
                  aria-label="Close diff"
                >
                  <div className="i-ph:x text-sm" />
                </button>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <pre
                  className="rounded-md p-3 text-xs font-mono leading-relaxed"
                  style={{
                    background: 'var(--bolt-elements-bg-depth-1)',
                    border: '1px solid var(--bolt-elements-borderColor)',
                  }}
                >
                  {diffModalContent.split('\n').map((line, i) => {
                    let color = 'var(--bolt-elements-textTertiary)';
                    let bg = 'transparent';

                    if (line.startsWith('+') && !line.startsWith('+++')) {
                      color = '#4ade80';
                      bg = 'rgba(74, 222, 128, 0.08)';
                    } else if (line.startsWith('-') && !line.startsWith('---')) {
                      color = '#f87171';
                      bg = 'rgba(248, 113, 113, 0.08)';
                    } else if (line.startsWith('@@')) {
                      color = '#60a5fa';
                    } else if (line.startsWith('diff ') || line.startsWith('index ')) {
                      color = 'var(--bolt-elements-textTertiary)';
                    }

                    return (
                      <div key={i} style={{ color, backgroundColor: bg }} className="whitespace-pre">
                        {line}
                      </div>
                    );
                  })}
                </pre>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Changed Files Modal */}
      <AnimatePresence>
        {filesModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.85)' }}
            onClick={() => setFilesModal(null)}
            role="dialog"
            aria-modal="true"
            aria-label="Changed files"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="rounded-xl overflow-hidden flex flex-col"
              style={{
                width: '90vw',
                maxWidth: '1000px',
                maxHeight: '85vh',
                background: 'var(--bolt-elements-bg-depth-2)',
                border: '2px solid var(--bolt-elements-borderColor)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: '1px solid var(--bolt-elements-borderColor)' }}
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-bolt-elements-textPrimary">
                    {filesModal.files.length} file{filesModal.files.length !== 1 ? 's' : ''} changed
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded text-xs font-mono"
                    style={{
                      background: 'var(--bolt-elements-button-secondary-background)',
                      color: 'var(--bolt-elements-textSecondary)',
                    }}
                  >
                    {filesModal.sha.slice(0, 7)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDownload(filesModal.sha, 'changed')}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs transition-colors"
                    style={{
                      background: 'var(--bolt-elements-button-secondary-background)',
                      color: 'var(--bolt-elements-textSecondary)',
                    }}
                    title="Download changed files"
                  >
                    <div className="i-ph:download-simple text-xs" />
                    <span>Changed</span>
                  </button>
                  <button
                    onClick={() => handleDownload(filesModal.sha, 'full')}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs transition-colors"
                    style={{
                      background: 'var(--bolt-elements-button-secondary-background)',
                      color: 'var(--bolt-elements-textSecondary)',
                    }}
                    title="Download full project"
                  >
                    <div className="i-ph:download-simple text-xs" />
                    <span>Full</span>
                  </button>
                  <button
                    onClick={() => setFilesModal(null)}
                    className="flex items-center justify-center rounded-full transition-colors"
                    style={{
                      width: '28px',
                      height: '28px',
                      background: 'var(--bolt-elements-button-secondary-background)',
                      color: 'var(--bolt-elements-textSecondary)',
                    }}
                    aria-label="Close changed files"
                  >
                    <div className="i-ph:x text-sm" />
                  </button>
                </div>
              </div>

              {/* File list with collapsible diffs */}
              <div className="flex-1 overflow-auto">
                {filesModal.files.map(({ file, status }) => {
                  const diff = filesModal.diffs.get(file);
                  const isExpanded = expandedFiles.has(file);

                  // Count additions and deletions from diff
                  let additions = 0;
                  let deletions = 0;

                  if (diff) {
                    for (const line of diff.split('\n')) {
                      if (line.startsWith('+') && !line.startsWith('+++')) {
                        additions++;
                      } else if (line.startsWith('-') && !line.startsWith('---')) {
                        deletions++;
                      }
                    }
                  }

                  return (
                    <div key={file} style={{ borderBottom: '1px solid var(--bolt-elements-borderColor)' }}>
                      <button
                        type="button"
                        className="flex items-center gap-2 px-4 py-2 w-full text-left cursor-pointer transition-colors hover:brightness-110"
                        style={{ background: 'var(--bolt-elements-bg-depth-3)' }}
                        onClick={() => {
                          setExpandedFiles((prev) => {
                            const next = new Set(prev);

                            if (next.has(file)) {
                              next.delete(file);
                            } else {
                              next.add(file);
                            }

                            return next;
                          });
                        }}
                        aria-expanded={isExpanded}
                      >
                        <div
                          className={`i-ph:caret-right text-xs transition-transform text-bolt-elements-textSecondary ${isExpanded ? 'rotate-90' : ''}`}
                        />
                        <span
                          className="w-4 text-center font-mono font-bold text-xs"
                          style={{
                            color: status === 'A' ? '#4ade80' : status === 'D' ? '#f87171' : '#fbbf24',
                          }}
                        >
                          {status}
                        </span>
                        <div className="i-ph:file-text text-xs text-bolt-elements-textSecondary" />
                        <span className="font-mono text-sm text-bolt-elements-textPrimary flex-1">{file}</span>
                        {(additions > 0 || deletions > 0) && (
                          <span className="flex items-center gap-1.5 font-mono text-xs ml-auto">
                            {additions > 0 && <span style={{ color: '#4ade80' }}>+{additions}</span>}
                            {deletions > 0 && <span style={{ color: '#f87171' }}>-{deletions}</span>}
                          </span>
                        )}
                      </button>
                      {isExpanded && diff && (
                        <pre
                          className="px-4 py-2 text-xs font-mono leading-relaxed overflow-x-auto"
                          style={{ background: 'var(--bolt-elements-bg-depth-1)' }}
                        >
                          {diff.split('\n').map((line, i) => {
                            let color = 'var(--bolt-elements-textTertiary)';
                            let bg = 'transparent';

                            if (line.startsWith('+') && !line.startsWith('+++')) {
                              color = '#4ade80';
                              bg = 'rgba(74, 222, 128, 0.08)';
                            } else if (line.startsWith('-') && !line.startsWith('---')) {
                              color = '#f87171';
                              bg = 'rgba(248, 113, 113, 0.08)';
                            } else if (line.startsWith('@@')) {
                              color = '#60a5fa';
                            } else if (line.startsWith('diff ') || line.startsWith('index ')) {
                              color = 'var(--bolt-elements-textTertiary)';
                            }

                            return (
                              <div key={i} style={{ color, backgroundColor: bg }} className="whitespace-pre">
                                {line}
                              </div>
                            );
                          })}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
