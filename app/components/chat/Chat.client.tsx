import { useStore } from '@nanostores/react';
import type { Message } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useAnimate } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import { toast } from 'sonner';
import { useMessageParser, usePromptEnhancer, useShortcuts } from '~/lib/hooks';
import { resetVersionTracking } from '~/lib/hooks/useMessageParser';
import { description, useChatHistory } from '~/lib/persistence';
import { chatId } from '~/lib/persistence/useChatHistory';
import type { ImportChatFn } from '~/lib/persistence/db';
import { getProjectPlanMode, setProjectPlanMode } from '~/lib/persistence/projectPlanMode';
import { bootRuntime, teardownCurrentRuntime } from '~/lib/runtime';
import { chatStore, clearPendingChatMessage } from '~/lib/stores/chat';
import { workbenchStore } from '~/lib/stores/workbench';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROMPT_COOKIE_KEY, PROVIDER_LIST } from '~/utils/constants';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import { BaseChat } from './BaseChat';
import Cookies from 'js-cookie';
import { debounce } from '~/utils/debounce';
import { useSettings } from '~/lib/hooks/useSettings';
import type { ProviderInfo } from '~/types/model';
import { useSearchParams } from 'react-router';
import { createSampler } from '~/utils/sampler';
import { getTemplates, selectStarterTemplate } from '~/utils/selectStarterTemplate';
import { logStore } from '~/lib/stores/logs';
import { streamingState } from '~/lib/stores/streaming';
import { filesToArtifacts } from '~/utils/fileUtils';
import { supabaseConnection } from '~/lib/stores/supabase';
import { defaultDesignScheme, type DesignScheme } from '~/types/design-scheme';
import type { ElementInfo } from '~/components/workbench/inspector-types';
import type { TextUIPart, FileUIPart, Attachment } from '@ai-sdk/ui-utils';
import { mcpStore } from '~/lib/stores/mcp';
import { agentModeStore } from '~/lib/stores/agentMode';
import { shouldAutoApproveAgentTool } from '~/utils/agentToolApproval';
import type { LlmErrorAlertType } from '~/types/actions';
import { handleFixSuccess, isAutoFixActive } from '~/lib/services/autoFixService';
import { hasExceededMaxRetries, recordFixAttempt, resetAutoFix } from '~/lib/stores/autofix';
import { planActionAtom, clearPlanAction } from '~/lib/stores/plan';
import { modelRoutingConfigStore, blueprintModeStore } from '~/lib/stores/settings';
import { resetStreamEventState } from '~/lib/stores/stream-event-router';
import type { PlanPhase } from '~/lib/agent/types';

const logger = createScopedLogger('Chat');

const AGENT_PHASE_LABELS: Record<PlanPhase, string> = {
  idle: 'Idle',
  planning: 'Planning',
  executing: 'Executing',
  reviewing: 'Reviewing',
};

const AGENT_PHASE_DOT_COLORS: Record<PlanPhase, string> = {
  idle: 'bg-gray-400',
  planning: 'bg-blue-400 animate-pulse',
  executing: 'bg-green-400 animate-pulse',
  reviewing: 'bg-amber-400 animate-pulse',
};

export function Chat() {
  renderLogger.trace('Chat');

  const [hasMounted, setHasMounted] = useState(false);
  const { ready, initialMessages, storeMessageHistory, importChat, exportChat } = useChatHistory();
  const title = useStore(description);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    workbenchStore.setReloadedMessages(initialMessages.map((m) => m.id));

    // Clear stale version tracking from previous chat sessions to prevent memory leaks
    resetVersionTracking();
  }, [initialMessages]);

  return (
    <>
      {hasMounted && ready && (
        <ChatImpl
          description={title}
          initialMessages={initialMessages}
          exportChat={exportChat}
          storeMessageHistory={storeMessageHistory}
          importChat={importChat}
        />
      )}
    </>
  );
}

const processSampledMessages = createSampler(
  (options: {
    messages: Message[];
    initialMessages: Message[];
    isLoading: boolean;
    parseMessages: (messages: Message[], isLoading: boolean) => void;
    storeMessageHistory: (messages: Message[]) => Promise<void>;
  }) => {
    const { messages, initialMessages, isLoading, parseMessages, storeMessageHistory } = options;
    parseMessages(messages, isLoading);

    if (messages.length > initialMessages.length) {
      storeMessageHistory(messages).catch((error) => toast.error(error.message));
    }
  },
  50,
);

interface ChatProps {
  initialMessages: Message[];
  storeMessageHistory: (messages: Message[]) => Promise<void>;
  importChat: ImportChatFn;
  exportChat: () => void;
  description?: string;
}

export const ChatImpl = memo(
  ({ description, initialMessages, storeMessageHistory, importChat, exportChat }: ChatProps) => {
    useShortcuts();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [chatStarted, setChatStarted] = useState(initialMessages.length > 0);
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
    const [imageDataList, setImageDataList] = useState<string[]>([]);
    const [searchParams, setSearchParams] = useSearchParams();
    const [fakeLoading, setFakeLoading] = useState(false);
    const liveFiles = useStore(workbenchStore.files);
    const filesRef = useRef(liveFiles);
    const [debouncedFiles, setDebouncedFiles] = useState(liveFiles);

    useEffect(() => {
      filesRef.current = liveFiles;

      const timer = setTimeout(() => setDebouncedFiles(liveFiles), 300);

      return () => clearTimeout(timer);
    }, [liveFiles]);

    const [designScheme, setDesignScheme] = useState<DesignScheme>(defaultDesignScheme);
    const actionAlert = useStore(workbenchStore.alert);
    const deployAlert = useStore(workbenchStore.deployAlert);
    const supabaseConn = useStore(supabaseConnection);
    const selectedProject = supabaseConn.stats?.projects?.find(
      (project) => project.id === supabaseConn.selectedProjectId,
    );
    const supabaseAlert = useStore(workbenchStore.supabaseAlert);
    const { activeProviders, promptId, autoSelectTemplate, contextOptimizationEnabled, enableThinking } = useSettings();
    const [llmErrorAlert, setLlmErrorAlert] = useState<LlmErrorAlertType | undefined>(undefined);
    const [model, setModel] = useState(() => {
      const savedModel = Cookies.get('selectedModel');
      return savedModel || DEFAULT_MODEL;
    });
    const [provider, setProvider] = useState(() => {
      const savedProvider = Cookies.get('selectedProvider');
      return (PROVIDER_LIST.find((p) => p.name === savedProvider) || DEFAULT_PROVIDER) as ProviderInfo;
    });

    /*
     * Validate restored provider/model against active (enabled) providers.
     * Stale cookies can reference a disabled/unconfigured provider (e.g. AmazonBedrock),
     * causing auth errors when the send flow embeds [Provider: ...] in the message.
     */
    useEffect(() => {
      if (activeProviders.length === 0) {
        return;
      }

      const fallbackProvider = (activeProviders.find((p) => p.name === DEFAULT_PROVIDER.name) ||
        activeProviders[0]) as ProviderInfo;
      const resolvedProvider = activeProviders.find((p) => p.name === provider.name) || fallbackProvider;

      if (resolvedProvider.name !== provider.name) {
        logger.warn(`Selected provider "${provider.name}" is not enabled — falling back to "${resolvedProvider.name}"`);
        setProvider(resolvedProvider);
        Cookies.set('selectedProvider', resolvedProvider.name, { expires: 30 });
      }

      const providerModels = resolvedProvider.staticModels.map((entry) => entry.name);
      const fallbackModel = providerModels[0] || DEFAULT_MODEL;
      const resolvedModel = providerModels.includes(model) ? model : fallbackModel;

      if (resolvedModel !== model) {
        logger.warn(
          `Selected model "${model}" is not available for "${resolvedProvider.name}" — falling back to "${resolvedModel}"`,
        );
        setModel(resolvedModel);
        Cookies.set('selectedModel', resolvedModel, { expires: 30 });
      }
    }, [activeProviders, model, provider.name]);

    const { showChat, pendingMessage } = useStore(chatStore);
    const [animationScope, animate] = useAnimate();
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [chatMode, setChatMode] = useState<'discuss' | 'build'>('build');
    const currentChatId = useStore(chatId);
    const [planMode, setPlanMode] = useState(false);
    const skipNextPlanModeSave = useRef(false);
    const prevChatIdRef = useRef<string | undefined>(undefined);
    const planModeRef = useRef(planMode);
    const modelRef = useRef(model);
    const providerRef = useRef(provider);
    const sendingRef = useRef(false);
    const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      return () => {
        if (pollTimeoutRef.current !== null) {
          clearTimeout(pollTimeoutRef.current);
          pollTimeoutRef.current = null;
        }
      };
    }, []);

    planModeRef.current = planMode;
    modelRef.current = model;
    providerRef.current = provider;

    const [selectedElement, setSelectedElement] = useState<ElementInfo | null>(null);
    const mcpSettings = useStore(mcpStore).settings;
    const agentState = useStore(agentModeStore);
    const modelRoutingConfig = useStore(modelRoutingConfigStore);
    const blueprintMode = useStore(blueprintModeStore);

    // Restore plan mode from localStorage when chat changes, or carry over pre-chat state
    useEffect(() => {
      const wasNewChat = prevChatIdRef.current === undefined && !!currentChatId;
      prevChatIdRef.current = currentChatId;

      if (!currentChatId) {
        // No chat yet — keep current planMode state so toggling before chat creation works
        return;
      }

      if (wasNewChat && planModeRef.current) {
        // New chat was just created and plan mode was toggled ON before — carry it over
        setProjectPlanMode(currentChatId, { enabled: true });
        skipNextPlanModeSave.current = true;

        return;
      }

      // Switching between existing chats or navigating to an existing chat — restore
      skipNextPlanModeSave.current = true;

      const settings = getProjectPlanMode(currentChatId);
      setPlanMode(settings.enabled);
    }, [currentChatId]);

    // Persist plan mode to localStorage when toggled
    useEffect(() => {
      if (!currentChatId) {
        return;
      }

      if (skipNextPlanModeSave.current) {
        skipNextPlanModeSave.current = false;
        return;
      }

      setProjectPlanMode(currentChatId, { enabled: planMode });
    }, [currentChatId, planMode]);

    // Boot the local runtime when a chat session is established
    useEffect(() => {
      if (!currentChatId) {
        return undefined;
      }

      bootRuntime(currentChatId).catch((error) => {
        logger.error('Failed to boot runtime:', error);
        toast.error('Failed to initialize project runtime');
      });

      return () => {
        /*
         * Tear down the old runtime so its dev-server / WebContainer stops
         * and the port is freed. This prevents stale previews and multiple
         * simultaneous localhost instances when switching between chats.
         *
         * Order matters: hide workbench first, then teardown runtime (kills
         * processes and frees ports), THEN reset previews. Resetting previews
         * before teardown causes the preview store to re-subscribe to port
         * events and pick up stale ports from the dying runtime.
         */
        workbenchStore.showWorkbench.set(false);
        workbenchStore.resetArtifacts();

        if (pollTimeoutRef.current !== null) {
          clearTimeout(pollTimeoutRef.current);
          pollTimeoutRef.current = null;
        }

        teardownCurrentRuntime()
          .catch((error) => {
            logger.error('Failed to teardown runtime on chat exit:', error);
          })
          .finally(() => {
            workbenchStore.resetPreviews();
          });
      };
    }, [currentChatId]);

    const {
      messages,
      isLoading,
      input,
      handleInputChange,
      setInput,
      stop,
      append,
      setMessages,
      reload,
      error,
      data: chatData,
      setData,
      addToolResult,
    } = useChat({
      api: '/api/chat',
      body: {
        apiKeys,
        files: debouncedFiles,
        promptId,
        contextOptimization: contextOptimizationEnabled,
        enableThinking,
        chatMode,
        designScheme,
        planMode,
        supabase: {
          isConnected: supabaseConn.isConnected,
          hasSelectedProject: !!selectedProject,
          credentials: {
            supabaseUrl: supabaseConn?.credentials?.supabaseUrl,
            anonKey: supabaseConn?.credentials?.anonKey,
          },
        },
        maxLLMSteps: mcpSettings.maxLLMSteps,
        agentMode: agentState.settings.enabled,
        ...(blueprintMode ? { blueprintMode: true } : {}),
        ...(Object.keys(modelRoutingConfig).length > 0 ? { modelRoutingConfig } : {}),
      },
      maxSteps: mcpSettings.maxLLMSteps,
      sendExtraMessageFields: true,
      async onToolCall({ toolCall }) {
        /*
         * Auto-approve and execute agent tools on the CLIENT side during streaming.
         * This solves two problems:
         * 1. Avoids addToolResult timing issue (status='streaming' causes early return)
         * 2. Avoids SSR runtime hang (server's `await runtime` never resolves)
         * By returning the actual tool result, maxSteps handles re-submission automatically
         * and the server receives the real result instead of 'Yes, approved.'
         */
        const currentSettings = agentModeStore.get().settings;

        if (currentSettings.enabled) {
          if (shouldAutoApproveAgentTool(toolCall.toolName, currentSettings)) {
            logger.debug(`[onToolCall] Auto-approving and executing agent tool: ${toolCall.toolName}`);

            try {
              const { executeAgentTool } = await import('~/lib/services/agentToolsService');
              const result = await executeAgentTool(toolCall.toolName, toolCall.args as Record<string, unknown>);
              logger.debug(`[onToolCall] Tool ${toolCall.toolName} completed`, result);

              return result;
            } catch (error) {
              logger.error(`[onToolCall] Failed to execute agent tool: ${toolCall.toolName}`, error);

              return { error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}` };
            }
          }
        }

        // Return undefined for tools that need manual approval (shows UI buttons)
        return undefined;
      },
      onError: (e) => {
        setFakeLoading(false);

        /*
         * If the stream errors during an auto-fix attempt, record the failure
         * so the system doesn't get stuck with isFixing: true forever.
         */
        if (isAutoFixActive()) {
          recordFixAttempt(false);
          logger.warn('Auto-fix stream errored — recording as failed attempt');
        }

        handleError(e, 'chat');
      },
      onFinish: (message, response) => {
        const usage = response.usage;
        setData(undefined);
        workbenchStore.resetDataStreamProcessing();

        // Reset agent phase tracking and streaming state when stream completes
        resetStreamEventState();
        agentModeStore.setKey('planPhase', 'idle');

        if (usage) {
          logger.debug('Token usage:', usage);
          logStore.logProvider('Chat response completed', {
            component: 'Chat',
            action: 'response',
            model,
            provider: provider.name,
            usage,
            messageLength: message.content.length,
          });
        }

        logger.debug('Finished streaming');

        // Finalize any actions stuck in 'running' (e.g. truncated closing tags)
        workbenchStore.finalizeRunningActions();

        /*
         * Check if this was an auto-fix response.
         * Poll for errors over a window long enough for actions to execute
         * (npm install + dev server restart can take 10-30 seconds).
         * If an error appears at any point, record failure immediately.
         * If no error after the full window, declare success.
         */
        if (isAutoFixActive()) {
          const POLL_INTERVAL_MS = 3_000;
          const MAX_POLLS = 5; // 5 polls × 3s = 15s total window
          let pollCount = 0;

          const pollForErrors = () => {
            pollCount++;

            // Guard: re-check auto-fix hasn't been reset or max retries reached
            if (!isAutoFixActive() || hasExceededMaxRetries()) {
              return;
            }

            const currentAlert = workbenchStore.actionAlert.get();

            if (currentAlert) {
              // Error detected — record failure immediately, stop polling
              recordFixAttempt(false);
              logger.debug(`Auto-fix attempt failed (detected at poll ${pollCount}/${MAX_POLLS})`);

              return;
            }

            if (pollCount >= MAX_POLLS) {
              // Full window elapsed with no new errors — fix was successful
              handleFixSuccess();
              logger.info('Auto-fix successful - no new errors detected after 15s');

              return;
            }

            // Schedule next poll
            pollTimeoutRef.current = setTimeout(pollForErrors, POLL_INTERVAL_MS);
          };

          // Start first poll after initial delay for file writes to flush
          pollTimeoutRef.current = setTimeout(pollForErrors, POLL_INTERVAL_MS);
        }
      },
      initialMessages,
      initialInput: Cookies.get(PROMPT_COOKIE_KEY) || '',
    });

    // Clear error-polling timeout when loading stops
    useEffect(() => {
      if (!isLoading && pollTimeoutRef.current !== null) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    }, [isLoading]);

    // Watch for pending messages from inspector panel
    useEffect(() => {
      if (pendingMessage) {
        setInput(pendingMessage);
        clearPendingChatMessage();

        // Ensure chat is visible
        if (!showChat) {
          chatStore.setKey('showChat', true);
        }
      }
    }, [pendingMessage, setInput, showChat]);

    const urlPrompt = searchParams.get('prompt');

    useEffect(() => {
      if (urlPrompt) {
        try {
          setSearchParams({});
        } catch (e) {
          logger.error('Failed to clear search params:', e);
        }

        void runAnimation();
        append({
          role: 'user',
          content: `[Model: ${modelRef.current}]\n\n[Provider: ${providerRef.current.name}]\n\n${urlPrompt}`,
        });
      }
    }, [urlPrompt]);

    const { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer } = usePromptEnhancer();
    const { parsedMessages, parseMessages } = useMessageParser();

    const TEXTAREA_MAX_HEIGHT = chatStarted ? 400 : 200;

    // Track if this is the initial parse (for session restore)
    const hasInitialParsed = useRef(false);

    useEffect(() => {
      chatStore.setKey('started', initialMessages.length > 0);
    }, [initialMessages.length]);

    useEffect(() => {
      processSampledMessages({
        messages,
        initialMessages,
        isLoading,
        parseMessages,
        storeMessageHistory,
      });

      /*
       * Clear the restoring flag after first parse of initial messages.
       * This MUST happen synchronously to prevent race conditions where
       * new messages arrive before the flag is cleared.
       * FIX: Removed requestAnimationFrame to prevent timing issues
       * that caused new file actions to be skipped after page refresh.
       */
      if (!hasInitialParsed.current && initialMessages.length > 0) {
        hasInitialParsed.current = true;

        // Clear reloaded messages set so new messages aren't treated as historical
        workbenchStore.clearReloadedMessages();

        // Set flag synchronously - must happen before any new messages can be parsed
        workbenchStore.isRestoringSession.set(false);
      }
    }, [messages, isLoading, parseMessages]);

    const scrollTextArea = () => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    };

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
      workbenchStore.abortAllActions();

      // If aborting during auto-fix, cancel the auto-fix session entirely
      if (isAutoFixActive()) {
        resetAutoFix();
        logger.info('Auto-fix cancelled — user aborted the response');
      }

      // Clear progress annotations so "Analysing Request" doesn't persist
      setData(undefined);
      workbenchStore.resetDataStreamProcessing();

      // Remove empty assistant message created by the aborted stream
      const lastMsg = messages[messages.length - 1];

      if (lastMsg?.role === 'assistant' && !lastMsg.content?.trim()) {
        setMessages(messages.slice(0, -1));
      }

      logStore.logProvider('Chat response aborted', {
        component: 'Chat',
        action: 'abort',
        model,
        provider: provider.name,
      });
    };

    const handleError = useCallback(
      (error: unknown, context: 'chat' | 'template' | 'llmcall' = 'chat') => {
        logger.error(`${context} request failed`, error);

        stop();
        setFakeLoading(false);

        const errorMessage = error instanceof Error ? error.message : String(error);

        let errorInfo = {
          message: 'An unexpected error occurred',
          isRetryable: true,
          statusCode: 500,
          provider: provider.name,
          type: 'unknown' as const,
          retryDelay: 0,
        };

        if (errorMessage) {
          try {
            const parsed = JSON.parse(errorMessage);

            if (parsed.error || parsed.message) {
              errorInfo = { ...errorInfo, ...parsed };
            } else {
              errorInfo.message = errorMessage;
            }
          } catch {
            errorInfo.message = errorMessage;
          }
        }

        let errorType: LlmErrorAlertType['errorType'] = 'unknown';
        let title = 'Request Failed';

        if (errorInfo.statusCode === 401 || errorInfo.message.toLowerCase().includes('api key')) {
          errorType = 'authentication';
          title = 'Authentication Error';
        } else if (errorInfo.statusCode === 429 || errorInfo.message.toLowerCase().includes('rate limit')) {
          errorType = 'rate_limit';
          title = 'Rate Limit Exceeded';
        } else if (errorInfo.message.toLowerCase().includes('quota')) {
          errorType = 'quota';
          title = 'Quota Exceeded';
        } else if (errorInfo.statusCode >= 500) {
          errorType = 'network';
          title = 'Server Error';
        }

        logStore.logError(`${context} request failed`, error, {
          component: 'Chat',
          action: 'request',
          error: errorInfo.message,
          context,
          retryable: errorInfo.isRetryable,
          errorType,
          provider: provider.name,
        });

        // Create API error alert
        setLlmErrorAlert({
          type: 'error',
          title,
          description: errorInfo.message,
          provider: provider.name,
          errorType,
        });
        setData([]);
        workbenchStore.resetDataStreamProcessing();
      },
      [provider.name, stop],
    );

    const clearApiErrorAlert = useCallback(() => {
      setLlmErrorAlert(undefined);
    }, []);

    useEffect(() => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.style.height = 'auto';

        const scrollHeight = textarea.scrollHeight;

        textarea.style.height = `${Math.min(scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
        textarea.style.overflowY = scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
      }
    }, [input, textareaRef]);

    const runAnimation = async () => {
      if (chatStarted) {
        return;
      }

      /*
       * Animate the intro element out before showing chat
       * Only animate if the element exists to prevent framer-motion errors
       */
      const introElement = document.querySelector('#intro');

      if (introElement) {
        await animate('#intro', { opacity: 0, flex: 1 }, { duration: 0.2, ease: cubicEasingFn });
      }

      // Batch both state updates together in a single transition
      startTransition(() => {
        setChatStarted(true);
        chatStore.setKey('started', true);
      });
    };

    // Helper function to create message parts array from text and images
    const createMessageParts = (text: string, images: string[] = []): Array<TextUIPart | FileUIPart> => {
      // Create an array of properly typed message parts
      const parts: Array<TextUIPart | FileUIPart> = [
        {
          type: 'text',
          text,
        },
      ];

      // Add image parts if any
      images.forEach((imageData) => {
        // Extract correct MIME type from the data URL
        const mimeType = imageData.split(';')[0].split(':')[1] || 'image/jpeg';

        // Create file part according to AI SDK format
        parts.push({
          type: 'file',
          mimeType,
          data: imageData.replace(/^data:image\/[^;]+;base64,/, ''),
        });
      });

      return parts;
    };

    // Helper function to convert File[] to Attachment[] for AI SDK
    const filesToAttachments = async (files: File[]): Promise<Attachment[] | undefined> => {
      if (files.length === 0) {
        return undefined;
      }

      const attachments = await Promise.all(
        files.map(
          (file) =>
            new Promise<Attachment>((resolve, reject) => {
              const reader = new FileReader();

              reader.onload = () => {
                resolve({
                  name: file.name,
                  contentType: file.type,
                  url: reader.result as string,
                });
              };

              reader.onerror = () => {
                reject(new Error(`Failed to read file: ${file.name}`));
              };

              reader.onabort = () => {
                reject(new Error(`File read aborted: ${file.name}`));
              };

              reader.readAsDataURL(file);
            }),
        ),
      );

      return attachments;
    };

    const sendMessage = async (_event?: React.UIEvent, messageInput?: string) => {
      const messageContent = messageInput || input;

      if (!messageContent?.trim()) {
        return;
      }

      if (isLoading) {
        abort();
        return;
      }

      // Prevent duplicate sends during async template selection
      if (sendingRef.current) {
        return;
      }

      // Guard: ensure selected provider is active/enabled before sending
      if (!activeProviders.some((p) => p.name === provider.name)) {
        toast.error(`Provider "${provider.name}" is not enabled. Please select an active provider from settings.`);
        return;
      }

      sendingRef.current = true;

      try {
        let finalMessageContent = messageContent;

        if (selectedElement) {
          logger.debug('Selected Element:', selectedElement);

          const elementInfo = `<div class=\"__boltSelectedElement__\" data-element='${JSON.stringify(selectedElement)}'>${JSON.stringify(`${selectedElement.displayText}`)}</div>`;
          finalMessageContent = messageContent + elementInfo;
        }

        // Await the animation to complete before proceeding
        await runAnimation();

        if (!chatStarted) {
          setFakeLoading(true);

          if (autoSelectTemplate && !planMode) {
            const { template, title } = await selectStarterTemplate({
              message: finalMessageContent,
              model,
              provider,
            });

            if (template !== 'blank') {
              const temResp = await getTemplates(template, title).catch((e) => {
                if (e.message.includes('rate limit')) {
                  toast.warning('Rate limit exceeded. Skipping starter template\n Continuing with blank template');
                } else {
                  toast.warning('Failed to import starter template\n Continuing with blank template');
                }

                return null;
              });

              if (temResp) {
                const { assistantMessage, userMessage } = temResp;
                const userMessageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;

                setMessages([
                  {
                    id: `1-${new Date().getTime()}`,
                    role: 'user',
                    content: userMessageText,
                    parts: createMessageParts(userMessageText, imageDataList),
                  },
                  {
                    id: `2-${new Date().getTime()}`,
                    role: 'assistant',
                    content: assistantMessage,
                  },
                  {
                    id: `3-${new Date().getTime()}`,
                    role: 'user',
                    content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userMessage}\n\nUser request:\n${finalMessageContent}`,
                    annotations: ['hidden'],
                  },
                ]);

                const reloadOptions =
                  uploadedFiles.length > 0
                    ? { experimental_attachments: await filesToAttachments(uploadedFiles) }
                    : undefined;

                reload(reloadOptions);
                setInput('');
                Cookies.remove(PROMPT_COOKIE_KEY);

                setUploadedFiles([]);
                setImageDataList([]);

                resetEnhancer();

                textareaRef.current?.blur();
                setFakeLoading(false);

                return;
              }
            }
          }

          // If autoSelectTemplate is disabled or template selection failed, proceed with normal message
          const userMessageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;
          const attachments = uploadedFiles.length > 0 ? await filesToAttachments(uploadedFiles) : undefined;

          setMessages([
            {
              id: `${new Date().getTime()}`,
              role: 'user',
              content: userMessageText,
              parts: createMessageParts(userMessageText, imageDataList),
              experimental_attachments: attachments,
            },
          ]);
          reload(attachments ? { experimental_attachments: attachments } : undefined);
          setFakeLoading(false);
          setInput('');
          Cookies.remove(PROMPT_COOKIE_KEY);

          setUploadedFiles([]);
          setImageDataList([]);

          resetEnhancer();

          textareaRef.current?.blur();

          return;
        }

        if (error != null) {
          setMessages(messages.slice(0, -1));
        }

        const modifiedFiles = workbenchStore.getModifiedFiles();

        chatStore.setKey('aborted', false);

        if (modifiedFiles !== undefined) {
          const userUpdateArtifact = filesToArtifacts(modifiedFiles, `${Date.now()}`);
          const messageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userUpdateArtifact}${finalMessageContent}`;

          const attachmentOptions =
            uploadedFiles.length > 0
              ? { experimental_attachments: await filesToAttachments(uploadedFiles) }
              : undefined;

          append(
            {
              role: 'user',
              content: messageText,
              parts: createMessageParts(messageText, imageDataList),
            },
            attachmentOptions,
          );

          workbenchStore.resetAllFileModifications();
        } else {
          const messageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;

          const attachmentOptions =
            uploadedFiles.length > 0
              ? { experimental_attachments: await filesToAttachments(uploadedFiles) }
              : undefined;

          append(
            {
              role: 'user',
              content: messageText,
              parts: createMessageParts(messageText, imageDataList),
            },
            attachmentOptions,
          );
        }

        setInput('');
        Cookies.remove(PROMPT_COOKIE_KEY);

        setUploadedFiles([]);
        setImageDataList([]);

        resetEnhancer();

        textareaRef.current?.blur();
      } finally {
        sendingRef.current = false;
        setFakeLoading(false);
      }
    };

    /**
     * Handles the change event for the textarea and updates the input state.
     * @param event - The change event from the textarea.
     */
    const onTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      handleInputChange(event);
    };

    /**
     * Debounced function to cache the prompt in cookies.
     * Caches the trimmed value of the textarea input after a delay to optimize performance.
     */
    const debouncedCachePrompt = useMemo(
      () =>
        debounce((event: React.ChangeEvent<HTMLTextAreaElement>) => {
          const trimmedValue = event.target.value.trim();
          Cookies.set(PROMPT_COOKIE_KEY, trimmedValue, { expires: 30 });
        }, 1000),
      [],
    );

    useEffect(() => {
      return () => debouncedCachePrompt.cancel();
    }, [debouncedCachePrompt]);

    /**
     * Watch the plan action atom for approval/rejection/modify events.
     * When the user clicks Approve in the Plan component, this fires
     * a follow-up message to the LLM telling it to execute the plan.
     */
    useEffect(() => {
      const unsubscribe = planActionAtom.subscribe((action) => {
        if (!action) {
          return;
        }

        // Consume the action immediately to prevent repeated triggers
        clearPlanAction();

        if (action === 'approve') {
          const executeMessage =
            `[Model: ${modelRef.current}]\n\n[Provider: ${providerRef.current.name}]\n\n` +
            `The plan has been approved. Execute all steps in PLAN.md now. ` +
            `Implement each task in order, creating files, writing code, and running commands as needed. ` +
            `After completing each step, update PLAN.md to mark it done with \`- [x]\`.`;

          // Switch from plan mode to build mode — planning is done, execution begins
          setPlanMode(false);

          void runAnimation();

          append({
            role: 'user',
            content: executeMessage,
          });
        } else if (action === 'reject') {
          // Plan already cleared by rejectPlan() — optionally notify user
          toast.info('Plan cancelled');
        } else if (action === 'modify') {
          // Open the PLAN.md file in the editor for the user to edit
          workbenchStore.setSelectedFile('/home/project/PLAN.md');

          if (!workbenchStore.showWorkbench.get()) {
            workbenchStore.showWorkbench.set(true);
          }

          toast.info('Edit PLAN.md in the editor, then approve when ready');
        }
      });

      return unsubscribe;
    }, []);

    useEffect(() => {
      const storedApiKeys = Cookies.get('apiKeys');

      if (storedApiKeys) {
        try {
          setApiKeys(JSON.parse(storedApiKeys));
        } catch {
          // Corrupted cookie — ignore silently
        }
      }
    }, []);

    const handleModelChange = (newModel: string) => {
      setModel(newModel);
      Cookies.set('selectedModel', newModel, { expires: 30 });
    };

    const handleProviderChange = (newProvider: ProviderInfo) => {
      setProvider(newProvider);
      Cookies.set('selectedProvider', newProvider.name, { expires: 30 });

      const availableModels = newProvider.staticModels.map((entry) => entry.name);
      const nextModel = availableModels.includes(model) ? model : availableModels[0] || DEFAULT_MODEL;

      if (nextModel !== model) {
        setModel(nextModel);
        Cookies.set('selectedModel', nextModel, { expires: 30 });
      }
    };

    const handleStreamingChange = useCallback((streaming: boolean) => {
      streamingState.set(streaming);
    }, []);

    const handleInputChangeWrapped = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onTextareaChange(e);
        debouncedCachePrompt(e);
      },
      [onTextareaChange, debouncedCachePrompt],
    );

    const handleEnhancePrompt = useCallback(() => {
      enhancePrompt(
        input,
        (enhancedInput: string) => {
          setInput(enhancedInput);
          scrollTextArea();
        },
        model,
        provider,
        apiKeys,
      );
    }, [input, enhancePrompt, setInput, scrollTextArea, model, provider, apiKeys]);

    const handleClearAlert = useCallback(() => workbenchStore.clearAlert(), []);
    const handleClearSupabaseAlert = useCallback(() => workbenchStore.clearSupabaseAlert(), []);
    const handleClearDeployAlert = useCallback(() => workbenchStore.clearDeployAlert(), []);

    const processedMessages = useMemo(
      () =>
        messages.map((message, i) => {
          if (message.role === 'user') {
            return message;
          }

          return {
            ...message,
            content: parsedMessages[i] || '',
          };
        }),
      [messages, parsedMessages],
    );

    const handleWebSearchResult = useCallback(
      (result: string) => {
        const currentInput = input || '';
        const newInput = currentInput ? `${result}\n\n---\n\n${currentInput}` : result;

        // Update the input via the same mechanism as handleInputChange
        const syntheticEvent = {
          target: { value: newInput },
        } as React.ChangeEvent<HTMLTextAreaElement>;
        handleInputChange(syntheticEvent);
      },
      [input, handleInputChange],
    );

    return (
      <div className="relative flex flex-col flex-1 min-h-0">
        {agentState.planPhase !== 'idle' && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-1.5 rounded-full bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor shadow-md pointer-events-none">
            <div className={`w-2 h-2 rounded-full ${AGENT_PHASE_DOT_COLORS[agentState.planPhase]}`} />
            <span className="text-xs font-medium text-bolt-elements-textSecondary">
              Agent {AGENT_PHASE_LABELS[agentState.planPhase]}
            </span>
          </div>
        )}
        <BaseChat
          ref={animationScope}
          textareaRef={textareaRef}
          input={input}
          showChat={showChat}
          chatStarted={chatStarted}
          isStreaming={isLoading || fakeLoading}
          onStreamingChange={handleStreamingChange}
          enhancingPrompt={enhancingPrompt}
          promptEnhanced={promptEnhanced}
          sendMessage={sendMessage}
          model={model}
          setModel={handleModelChange}
          provider={provider}
          setProvider={handleProviderChange}
          providerList={activeProviders}
          handleInputChange={handleInputChangeWrapped}
          handleStop={abort}
          description={description}
          importChat={importChat}
          exportChat={exportChat}
          messages={processedMessages}
          enhancePrompt={handleEnhancePrompt}
          uploadedFiles={uploadedFiles}
          setUploadedFiles={setUploadedFiles}
          imageDataList={imageDataList}
          setImageDataList={setImageDataList}
          actionAlert={actionAlert}
          clearAlert={handleClearAlert}
          supabaseAlert={supabaseAlert}
          clearSupabaseAlert={handleClearSupabaseAlert}
          deployAlert={deployAlert}
          clearDeployAlert={handleClearDeployAlert}
          llmErrorAlert={llmErrorAlert}
          clearLlmErrorAlert={clearApiErrorAlert}
          data={chatData}
          chatMode={chatMode}
          setChatMode={setChatMode}
          planMode={planMode}
          setPlanMode={setPlanMode}
          append={append}
          designScheme={designScheme}
          setDesignScheme={setDesignScheme}
          selectedElement={selectedElement}
          setSelectedElement={setSelectedElement}
          addToolResult={addToolResult}
          onWebSearchResult={handleWebSearchResult}
        />
      </div>
    );
  },
);
