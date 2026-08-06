import type { Message } from 'ai';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { atom } from 'nanostores';
import { useStore } from '@nanostores/react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '~/utils/cn';
import { AssistantMessage } from './AssistantMessage';
import { UserMessage } from './UserMessage';
import { useLocation, useNavigate } from 'react-router';
import { db, chatId } from '~/lib/persistence/useChatHistory';
import { forkChat, getBranchesByParentChatId } from '~/lib/persistence/db';
import { toast } from 'sonner';
import type { ProviderInfo } from '~/types/model';
import type { BranchMetadata } from '~/lib/agent/types';
import { agentModeStore } from '~/lib/stores/agentMode';
import { versionsStore } from '~/lib/stores/versions';
import { checkout } from '~/lib/runtime/git-client';
import { runtimeContext } from '~/lib/runtime';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('Messages');

/**
 * Branch parent info for the current chat (set when viewing a forked/branched conversation).
 * Stored in localStorage keyed by urlId so it persists across page reloads.
 */
export const currentBranchParentAtom = atom<{
  parentChatId: string;
  branchPointMessageId: string;
} | null>(null);

/**
 * Map of messageId → number of branches originating from that message in the current chat.
 * Populated on chat load by scanning the 'branches' IndexedDB store.
 */
export const messageBranchCountsAtom = atom<Record<string, number>>({});

/** Queries the 'branches' IndexedDB store index for all branches at a given messageId. */
async function getBranchesByMessageId(database: IDBDatabase, messageId: string): Promise<BranchMetadata[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('branches', 'readonly');
    const store = transaction.objectStore('branches');
    const index = store.index('branchPointMessageId');
    const request = index.getAll(messageId);

    request.onsuccess = () => resolve(request.result as BranchMetadata[]);
    request.onerror = () => reject(request.error);
  });
}

interface MessagesProps {
  id?: string;
  className?: string;
  isStreaming?: boolean;
  messages?: Message[];
  append?: (message: Message) => void;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
  model?: string;
  provider?: ProviderInfo;
  addToolResult: ({ toolCallId, result }: { toolCallId: string; result: unknown }) => void;
  ref?: React.Ref<HTMLDivElement>;
}

/**
 * Compact badge displayed when the current chat is a branch of another conversation.
 * Shows a link back to the parent chat.
 */
function BranchIndicator({ parentChatId }: { parentChatId: string }) {
  const navigate = useNavigate();

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-md bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor text-xs">
      <div className="i-ph:git-branch text-bolt-elements-textTertiary w-4 h-4 shrink-0" />
      <span className="text-bolt-elements-textSecondary">Branched from</span>
      <button
        onClick={() => navigate(`/chat/${parentChatId}`)}
        className="text-bolt-elements-item-contentAccent hover:underline truncate max-w-48"
      >
        parent conversation
      </button>
    </div>
  );
}

/**
 * Inline dropdown that lists sibling branches originating from the same message.
 * Branches are lazy-loaded from IndexedDB only when the dropdown opens.
 */
function BranchSelector({ messageId, count }: { messageId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleToggle = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }

    if (!db) {
      return;
    }

    setOpen(true);

    if (branches.length === 0) {
      setLoading(true);

      try {
        const result = await getBranchesByMessageId(db, messageId);
        setBranches(result);
      } catch (error) {
        logger.error('Failed to load branches', error);
        toast.error('Failed to load branches');
      } finally {
        setLoading(false);
      }
    }
  }, [open, branches.length, messageId]);

  return (
    <div className="relative mt-1">
      <button
        onClick={handleToggle}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors',
          'text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary',
          'hover:bg-bolt-elements-background-depth-2',
        )}
      >
        <div className="i-ph:git-branch w-3.5 h-3.5" />
        <span>
          {count} {count === 1 ? 'branch' : 'branches'}
        </span>
        <div className={cn('i-ph:caret-down w-3 h-3 transition-transform', { 'rotate-180': open })} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-40 min-w-56 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-3">
              <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-textTertiary" />
            </div>
          ) : branches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-bolt-elements-textTertiary">No branches found</div>
          ) : (
            branches.map((branch) => (
              <button
                key={branch.branchId}
                onClick={() => {
                  setOpen(false);
                  navigate(`/chat/${branch.branchId}`);
                }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-2"
              >
                <div className="i-ph:git-branch w-3.5 h-3.5 text-bolt-elements-textTertiary shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="text-bolt-elements-textPrimary truncate">{branch.label}</span>
                  <span className="text-bolt-elements-textTertiary">
                    {new Date(branch.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const AGENT_PHASE_COLORS: Record<string, string> = {
  planning: 'bg-blue-500/15 text-blue-400',
  executing: 'bg-green-500/15 text-green-400',
  reviewing: 'bg-amber-500/15 text-amber-400',
};

const AGENT_PHASE_ICONS: Record<string, string> = {
  planning: 'i-ph:notepad',
  executing: 'i-ph:play-circle',
  reviewing: 'i-ph:magnifying-glass',
};

const AGENT_PHASE_LABELS: Record<string, string> = {
  planning: 'Planning',
  executing: 'Executing',
  reviewing: 'Reviewing',
};

/**
 * Inline indicator showing the current agent phase when actively streaming.
 * Displays at the bottom of the messages list during agent sessions.
 */
function AgentPhaseIndicator({ phase }: { phase: string }) {
  if (phase === 'idle') {
    return null;
  }

  const colorClass = AGENT_PHASE_COLORS[phase] ?? 'bg-gray-500/15 text-gray-400';
  const iconClass = AGENT_PHASE_ICONS[phase] ?? 'i-ph:circle';
  const label = AGENT_PHASE_LABELS[phase] ?? phase;

  return (
    <div className="flex items-center gap-2 py-2 px-3 my-1 rounded-md bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor">
      <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-textTertiary w-3.5 h-3.5" />
      <div className={cn('w-4 h-4', iconClass)} />
      <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded-md', colorClass)}>{label}</span>
      <span className="text-xs text-bolt-elements-textTertiary">in progress</span>
    </div>
  );
}

export function Messages(props: MessagesProps) {
  const { id, isStreaming = false, messages = [], ref } = props;
  const location = useLocation();

  // Track the initial message count so we only animate messages that arrive after mount
  const initialMessageCountRef = useRef(messages.length);

  // Subscribe to branch state atoms
  const branchParent = useStore(currentBranchParentAtom);
  const branchCounts = useStore(messageBranchCountsAtom);

  // Subscribe to agent phase for inline progress indicator
  const agentState = useStore(agentModeStore);

  // Load branch info when the chat changes
  useEffect(() => {
    const urlIdMatch = location.pathname.match(/\/chat\/(.+)/);
    const currentUrlId = urlIdMatch?.[1];

    // Check if the current chat is a branch (child) by looking up localStorage
    if (currentUrlId) {
      try {
        const stored = localStorage.getItem(`bolt_branch_parent_${currentUrlId}`);

        if (stored) {
          currentBranchParentAtom.set(JSON.parse(stored));
        } else {
          currentBranchParentAtom.set(null);
        }
      } catch {
        currentBranchParentAtom.set(null);
      }
    } else {
      currentBranchParentAtom.set(null);
    }

    // Load branch counts for all messages in this chat (as a parent)
    const currentId = chatId.get();

    if (db && currentId) {
      getBranchesByParentChatId(db, currentId)
        .then((allBranches) => {
          const counts: Record<string, number> = {};

          for (const branch of allBranches) {
            counts[branch.branchPointMessageId] = (counts[branch.branchPointMessageId] || 0) + 1;
          }

          messageBranchCountsAtom.set(counts);
        })
        .catch((error) => {
          logger.error('Failed to load branch counts', error);
          messageBranchCountsAtom.set({});
        });
    } else {
      messageBranchCountsAtom.set({});
    }
  }, [location.pathname]);

  const handleRewind = async (messageId: string) => {
    /*
     * Checkpoint-aware rewind: every AI turn auto-commits the workspace and links
     * the commit SHA to the message via versionsStore. Restore the files to that
     * checkpoint before truncating the chat, so rewind rolls back code AND
     * conversation together (bolt.new-style checkpoints). Falls back to a
     * chat-only rewind when no checkpoint commit exists for the message.
     */
    try {
      // Read projectId at call time since runtimeContext is non-reactive
      const projectId = runtimeContext.projectId;
      const checkpoint = versionsStore
        .getAllVersions()
        .filter((version) => version.messageId === messageId && version.commitSha)
        .sort((a, b) => b.timestamp - a.timestamp)[0];

      if (projectId && checkpoint?.commitSha) {
        const success = await checkout(projectId, checkpoint.commitSha);

        if (!success) {
          toast.warning('Could not restore files for this checkpoint — rewinding chat only');
        }
      } else {
        toast.info('No file checkpoint found for this message — rewinding chat only');
      }
    } catch (error) {
      logger.error('Checkpoint restore failed during rewind', error);
      toast.warning('Could not restore files for this checkpoint — rewinding chat only');
    }

    const searchParams = new URLSearchParams(location.search);
    searchParams.set('rewindTo', messageId);
    window.location.search = searchParams.toString();
  };

  const handleFork = async (messageId: string) => {
    try {
      if (!db || !chatId.get()) {
        toast.error('Chat persistence is not available');
        return;
      }

      const parentId = chatId.get()!;
      const urlId = await forkChat(db, parentId, messageId, { branchPointMessageId: messageId });

      // Store parent mapping so the child chat can display its branch indicator
      try {
        localStorage.setItem(
          `bolt_branch_parent_${urlId}`,
          JSON.stringify({ parentChatId: parentId, branchPointMessageId: messageId }),
        );
      } catch {
        // localStorage full or unavailable — branch indicator won't show, but fork still works
      }

      window.location.href = `/chat/${urlId}`;
    } catch (error) {
      toast.error('Failed to fork chat: ' + (error as Error).message);
    }
  };

  return (
    <div id={id} className={props.className} ref={ref}>
      {branchParent && <BranchIndicator parentChatId={branchParent.parentChatId} />}
      <AnimatePresence initial={false}>
        {messages.length > 0
          ? messages.map((message, index) => {
              const { role, content, id: messageId, annotations, parts } = message;
              const isUserMessage = role === 'user';
              const isFirst = index === 0;
              const isHidden = annotations?.includes('hidden');

              if (isHidden) {
                return <Fragment key={message.id} />;
              }

              const branchCount = messageId ? (branchCounts[messageId] ?? 0) : 0;
              const isNewMessage = index >= initialMessageCountRef.current;

              return (
                <motion.div
                  key={message.id}
                  initial={isNewMessage ? { opacity: 0, x: isUserMessage ? 20 : -20 } : false}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: isUserMessage ? 0.2 : 0.25, ease: 'easeOut' }}
                  className={cn('flex gap-4 py-3 w-full rounded-lg', {
                    'mt-4': !isFirst,
                  })}
                >
                  <div className="grid grid-col-1 w-full">
                    {isUserMessage ? (
                      <UserMessage content={content} parts={parts} />
                    ) : (
                      <AssistantMessage
                        content={content}
                        annotations={message.annotations}
                        messageId={messageId}
                        onRewind={handleRewind}
                        onFork={handleFork}
                        append={props.append}
                        chatMode={props.chatMode}
                        setChatMode={props.setChatMode}
                        model={props.model}
                        provider={props.provider}
                        parts={parts}
                        addToolResult={props.addToolResult}
                      />
                    )}
                    {!isUserMessage && messageId && branchCount > 0 && (
                      <BranchSelector messageId={messageId} count={branchCount} />
                    )}
                  </div>
                </motion.div>
              );
            })
          : null}
      </AnimatePresence>
      {isStreaming && agentState.planPhase !== 'idle' && <AgentPhaseIndicator phase={agentState.planPhase} />}
      <AnimatePresence>
        {isStreaming && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="flex items-center justify-center gap-2 w-full mt-4"
          >
            <div className="i-svg-spinners:3-dots-fade text-xl text-bolt-elements-item-contentAccent" />
            <motion.span
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
              className="text-sm text-bolt-elements-textSecondary"
            >
              Generating...
            </motion.span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
