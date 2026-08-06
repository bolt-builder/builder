import type { JSONValue, Message } from 'ai';
import React, {
  type RefCallback,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { clientLazy } from '~/utils/react';

import { cn } from '~/utils/cn';
import { PROVIDER_LIST } from '~/utils/constants';
import { getApiKeysFromCookies } from './APIKeyManager';
import { encryptApiKeyValue, isEncryptedValue } from '~/lib/api/encrypt-value';
import Cookies from 'js-cookie';
import * as Tooltip from '@radix-ui/react-tooltip';
import styles from './BaseChat.module.scss';
import { CliAgentLauncher } from '~/components/chat/CliAgentLauncher';
import { LeftActionPanel } from '~/components/chat/LeftActionPanel';
import { TemplateSection } from '~/components/chat/TemplateSection';
import type { ProviderInfo } from '~/types/model';
import type { ActionAlert, SupabaseAlert, DeployAlert, LlmErrorAlertType } from '~/types/actions';
import type { ImportChatFn } from '~/lib/persistence/db';
import type { ModelInfo } from '~/lib/modules/llm/types';
import ProgressCompilation from './ProgressCompilation';
import type { ProgressAnnotation } from '~/types/context';
import { expoUrlAtom } from '~/lib/stores/qrCode';
import { workbenchStore } from '~/lib/stores/workbench';
import { inspectorApiAtom, inspectorModeAtom } from '~/lib/stores/inspector';
import { useStore } from '@nanostores/react';
import { StickToBottom, useStickToBottomContext } from '~/lib/hooks';
import { ChatBox } from './ChatBox';
import { InspectorPanel } from '~/components/workbench/InspectorPanel';
import type { DesignScheme } from '~/types/design-scheme';
import type { ElementInfo } from '~/components/workbench/inspector-types';
import { ResizeHandle } from '~/components/ui/ResizeHandle';
import { PanelErrorBoundary } from '~/components/ui/PanelErrorBoundary';
import { createScopedLogger } from '~/utils/logger';
import { toast } from 'sonner';
import { receiveServerValidation } from '~/lib/services/autoFixService';

const Workbench = clientLazy(() =>
  import('~/components/workbench/Workbench.client').then((m) => ({ default: m.Workbench })),
);
const Messages = clientLazy(() => import('./Messages.client').then((m) => ({ default: m.Messages })));
const DeployChatAlert = lazy(() => import('~/components/deploy/DeployAlert'));
const ChatAlert = lazy(() => import('./ChatAlert'));
const SupabaseChatAlert = lazy(() =>
  import('~/components/chat/SupabaseAlert').then((m) => ({ default: m.SupabaseChatAlert })),
);
const LlmErrorAlert = lazy(() => import('./LLMApiAlert'));
const Menu = clientLazy(() => import('~/components/sidebar/Menu.client').then((m) => ({ default: m.Menu })));

const logger = createScopedLogger('BaseChat');

const TEXTAREA_MIN_HEIGHT = 76;

interface BaseChatProps {
  textareaRef?: React.RefObject<HTMLTextAreaElement | null> | undefined;
  messageRef?: RefCallback<HTMLDivElement> | undefined;
  scrollRef?: RefCallback<HTMLDivElement> | undefined;
  showChat?: boolean;
  chatStarted?: boolean;
  isStreaming?: boolean;
  onStreamingChange?: (streaming: boolean) => void;
  messages?: Message[];
  description?: string;
  enhancingPrompt?: boolean;
  promptEnhanced?: boolean;
  input?: string;
  model?: string;
  setModel?: (model: string) => void;
  provider?: ProviderInfo;
  setProvider?: (provider: ProviderInfo) => void;
  providerList?: ProviderInfo[];
  handleStop?: () => void;
  sendMessage?: (event?: React.UIEvent, messageInput?: string) => void;
  handleInputChange?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  enhancePrompt?: () => void;
  importChat?: ImportChatFn;
  exportChat?: () => void;
  uploadedFiles?: File[];
  setUploadedFiles?: (files: File[]) => void;
  imageDataList?: string[];
  setImageDataList?: (dataList: string[]) => void;
  actionAlert?: ActionAlert;
  clearAlert?: () => void;
  supabaseAlert?: SupabaseAlert;
  clearSupabaseAlert?: () => void;
  deployAlert?: DeployAlert;
  clearDeployAlert?: () => void;
  llmErrorAlert?: LlmErrorAlertType;
  clearLlmErrorAlert?: () => void;
  data?: JSONValue[] | undefined;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
  planMode?: boolean;
  setPlanMode?: (enabled: boolean) => void;
  append?: (message: Message) => void;
  designScheme?: DesignScheme;
  setDesignScheme?: (scheme: DesignScheme) => void;
  selectedElement?: ElementInfo | null;
  setSelectedElement?: (element: ElementInfo | null) => void;
  addToolResult?: ({ toolCallId, result }: { toolCallId: string; result: unknown }) => void;
  onWebSearchResult?: (result: string) => void;
  ref?: React.Ref<HTMLDivElement>;
}

/* ─── Isolated inspector slot (avoids re-rendering the entire chat) ── */

const InspectorPanelSlot = memo(() => {
  const inspectorApi = useStore(inspectorApiAtom);
  const inspectorMode = useStore(inspectorModeAtom);

  /*
   * Show panel when inspector is enabled (mode !== 'off') and API is available.
   * The panel handles the empty state internally when no element is selected.
   */
  if (inspectorMode === 'off' || !inspectorApi) {
    return null;
  }

  return <InspectorPanel inspector={inspectorApi} />;
});
InspectorPanelSlot.displayName = 'InspectorPanelSlot';

/* ─── Main component ──────────────────────────────────────────────── */

export const BaseChat = React.memo(
  ({
    textareaRef,
    showChat = true,
    chatStarted = false,
    isStreaming = false,
    onStreamingChange,
    model,
    setModel,
    provider,
    setProvider,
    providerList,
    input = '',
    enhancingPrompt,
    handleInputChange,

    // promptEnhanced,
    enhancePrompt,
    sendMessage,
    handleStop,
    importChat,
    exportChat,
    uploadedFiles = [],
    setUploadedFiles,
    imageDataList = [],
    setImageDataList,
    messages,
    actionAlert,
    clearAlert,
    deployAlert,
    clearDeployAlert,
    supabaseAlert,
    clearSupabaseAlert,
    llmErrorAlert,
    clearLlmErrorAlert,
    data,
    chatMode,
    setChatMode,
    planMode,
    setPlanMode,
    append,
    designScheme,
    setDesignScheme,
    selectedElement,
    setSelectedElement,
    addToolResult = () => {
      throw new Error('addToolResult not implemented');
    },
    onWebSearchResult,
    ref,
  }: BaseChatProps) => {
    const TEXTAREA_MAX_HEIGHT = useMemo(() => (chatStarted ? 400 : 200), [chatStarted]);
    const [apiKeys, setApiKeys] = useState<Record<string, string>>(getApiKeysFromCookies());
    const [modelList, setModelList] = useState<ModelInfo[]>([]);
    const [isModelSettingsCollapsed, setIsModelSettingsCollapsed] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [recognition, setRecognition] = useState<SpeechRecognition | null>(null);
    const [transcript, setTranscript] = useState('');
    const [isModelLoading, setIsModelLoading] = useState<string | undefined>('all');
    const [progressAnnotations, setProgressAnnotations] = useState<ProgressAnnotation[]>([]);
    const processedEventIdsRef = useRef(new Set<string>());
    const expoUrl = useStore(expoUrlAtom);
    const showWorkbench = useStore(workbenchStore.showWorkbench);
    const workbenchWidth = useStore(workbenchStore.workbenchWidth);
    const inspectorActive = useStore(inspectorModeAtom) !== 'off';
    const [qrModalOpen, setQrModalOpen] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const [isHydrated, setIsHydrated] = useState(false);

    const handleResize = useCallback(
      (deltaX: number) => {
        // Negative delta means dragging left (making workbench bigger)
        const newWidth = workbenchWidth - deltaX;
        workbenchStore.setWorkbenchWidth(newWidth);
      },
      [workbenchWidth],
    );

    useEffect(() => {
      setIsHydrated(true);
    }, []);

    useEffect(() => {
      if (expoUrl) {
        setQrModalOpen(true);
      }
    }, [expoUrl]);

    useEffect(() => {
      if (data) {
        const progressList = data.filter(
          (x) =>
            typeof x === 'object' && x !== null && 'type' in x && (x as Record<string, unknown>).type === 'progress',
        ) as ProgressAnnotation[];
        setProgressAnnotations(progressList);

        // Process devonz_event entries (blueprint errors + error_validation)
        for (const item of data) {
          if (typeof item !== 'object' || item === null || !('devonz_event' in item)) {
            continue;
          }

          const evt = (item as Record<string, unknown>).devonz_event;

          if (typeof evt !== 'object' || evt === null || !('type' in evt)) {
            continue;
          }

          const event = evt as Record<string, unknown>;
          const eventKey = `${event.type}-${event.timestamp ?? ''}-${event.code ?? ''}-${event.fingerprint ?? ''}`;

          if (processedEventIdsRef.current.has(eventKey)) {
            continue;
          }

          processedEventIdsRef.current.add(eventKey);

          // Cap the Set size to prevent unbounded memory growth during long sessions
          if (processedEventIdsRef.current.size > 1000) {
            const entries = Array.from(processedEventIdsRef.current).slice(-1000);
            processedEventIdsRef.current.clear();

            for (const entry of entries) {
              processedEventIdsRef.current.add(entry);
            }
          }

          if (event.type === 'error' && typeof event.message === 'string') {
            const recoverable = event.recoverable === true;
            toast.warning(event.message, {
              duration: recoverable ? 5000 : Infinity,
            });
            logger.warn('Blueprint error event:', event.message);
          }

          if (
            event.type === 'error_validation' &&
            typeof event.category === 'string' &&
            typeof event.fingerprint === 'string' &&
            typeof event.suggestion === 'string' &&
            typeof event.loopDetected === 'boolean'
          ) {
            receiveServerValidation({
              category: event.category as 'import-resolution' | 'syntax' | 'type' | 'runtime' | 'build' | 'unknown',
              fingerprint: event.fingerprint,
              suggestion: event.suggestion,
              loopDetected: event.loopDetected,
            });
            logger.debug('Processed error_validation event:', event.fingerprint);
          }
        }

        workbenchStore.processDataStreamItems(data);
      } else {
        setProgressAnnotations([]);
        processedEventIdsRef.current.clear();
      }
    }, [data]);
    useEffect(() => {
      logger.debug(transcript);
    }, [transcript]);

    useEffect(() => {
      onStreamingChange?.(isStreaming);
    }, [isStreaming, onStreamingChange]);

    const handleInputChangeRef = useRef(handleInputChange);

    useEffect(() => {
      handleInputChangeRef.current = handleInputChange;
    }, [handleInputChange]);

    useEffect(() => {
      if (typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;

        recognition.onresult = (event) => {
          const transcript = Array.from(event.results)
            .map((result) => result[0])
            .map((result) => result.transcript)
            .join('');

          setTranscript(transcript);

          if (handleInputChangeRef.current) {
            const syntheticEvent = {
              target: { value: transcript },
            } as React.ChangeEvent<HTMLTextAreaElement>;
            handleInputChangeRef.current(syntheticEvent);
          }
        };

        recognition.onerror = (event) => {
          logger.error('Speech recognition error:', event.error);
          setIsListening(false);
          setTranscript('');
        };

        setRecognition(recognition);

        return () => {
          recognition.abort();
          recognition.onresult = null;
          recognition.onerror = null;
        };
      }

      return undefined;
    }, []);

    useEffect(() => {
      const abortController = new AbortController();

      if (typeof window !== 'undefined') {
        let parsedApiKeys: Record<string, string> | undefined = {};

        try {
          const rawKeys = getApiKeysFromCookies();

          /*
           * Encrypted values should not be surfaced in the UI state — the
           * server reads them directly from the cookie.  Replace encrypted
           * entries with empty strings so the UI knows a key is "set" only
           * through the provider key-status check, not via the raw value.
           */
          parsedApiKeys = {};

          for (const [k, v] of Object.entries(rawKeys)) {
            parsedApiKeys[k] = isEncryptedValue(v) ? '' : v;
          }

          setApiKeys(parsedApiKeys);
        } catch (error) {
          logger.error('Error loading API keys from cookies:', error);
          Cookies.remove('apiKeys');
        }

        setIsModelLoading('all');
        fetch('/api/models', { signal: abortController.signal })
          .then((response) => {
            if (!response.ok) {
              throw new Error(`Model fetch failed: ${response.status}`);
            }

            return response.json();
          })
          .then((data) => {
            const typedData = (data as { data?: { modelList?: ModelInfo[] } }).data;
            setModelList(Array.isArray(typedData?.modelList) ? typedData.modelList : []);
          })
          .catch((error) => {
            if (!abortController.signal.aborted) {
              logger.error('Error fetching model list:', error);
            }
          })
          .finally(() => {
            if (!abortController.signal.aborted) {
              setIsModelLoading(undefined);
            }
          });
      }

      // Fetch models once on mount — provider/key changes are handled by onApiKeysChange
      return () => {
        abortController.abort();
      };
    }, []);

    const onApiKeysChange = useCallback(
      async (providerName: string, apiKey: string) => {
        const newApiKeys = { ...apiKeys, [providerName]: apiKey };
        setApiKeys(newApiKeys);

        // Encrypt the key before storing in cookies
        const encryptedKey = await encryptApiKeyValue(apiKey);
        const cookieKeys = { ...apiKeys, [providerName]: encryptedKey };

        Cookies.set('apiKeys', JSON.stringify(cookieKeys), {
          secure: window.location.protocol === 'https:',
          sameSite: 'strict',
          expires: 30,
        });

        setIsModelLoading(providerName);

        let providerModels: ModelInfo[] = [];

        try {
          const response = await fetch(`/api/models/${encodeURIComponent(providerName)}`);

          if (!response.ok) {
            throw new Error(`Provider model fetch failed: ${response.status}`);
          }

          const data = await response.json();
          const parsed = (data as { data?: { modelList?: ModelInfo[] } }).data?.modelList;
          providerModels = Array.isArray(parsed) ? parsed : [];
        } catch (error) {
          logger.error('Error loading dynamic models for:', providerName, error);
        }

        // Only update models for the specific provider
        setModelList((prevModels) => {
          const otherModels = prevModels.filter((model) => model.provider !== providerName);
          return [...otherModels, ...providerModels];
        });
        setIsModelLoading(undefined);
      },
      [apiKeys],
    );

    const startListening = useCallback(() => {
      if (recognition) {
        recognition.start();
        setIsListening(true);
      }
    }, [recognition]);

    const stopListening = useCallback(() => {
      if (recognition) {
        recognition.stop();
        setIsListening(false);
      }
    }, [recognition]);

    const handleSendMessage = useCallback(
      (event?: React.UIEvent, messageInput?: string) => {
        if (sendMessage) {
          sendMessage(event, messageInput);
          setSelectedElement?.(null);

          if (recognition) {
            recognition.abort(); // Stop current recognition
            setTranscript(''); // Clear transcript
            setIsListening(false);

            // Clear the input by triggering handleInputChange with empty value
            if (handleInputChange) {
              const syntheticEvent = {
                target: { value: '' },
              } as React.ChangeEvent<HTMLTextAreaElement>;
              handleInputChange(syntheticEvent);
            }
          }
        }
      },
      [sendMessage, setSelectedElement, recognition, handleInputChange],
    );

    const handleFileUpload = useCallback(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';

      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];

        if (file) {
          const reader = new FileReader();

          reader.onload = (e) => {
            const base64Image = e.target?.result as string;
            setUploadedFiles?.([...uploadedFiles, file]);
            setImageDataList?.([...imageDataList, base64Image]);
          };

          reader.onerror = () => {
            logger.error('Failed to read image file:', reader.error);
          };

          reader.readAsDataURL(file);
        }
      };

      input.click();
    }, [uploadedFiles, imageDataList, setUploadedFiles, setImageDataList]);

    const handlePaste = useCallback(
      async (e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items;

        if (!items) {
          return;
        }

        for (const item of items) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();

            const file = item.getAsFile();

            if (file) {
              const reader = new FileReader();

              reader.onload = (e) => {
                const base64Image = e.target?.result as string;
                setUploadedFiles?.([...uploadedFiles, file]);
                setImageDataList?.([...imageDataList, base64Image]);
              };

              reader.onerror = () => {
                logger.error('Failed to read pasted image:', reader.error);
              };

              reader.readAsDataURL(file);
            }

            break;
          }
        }
      },
      [uploadedFiles, imageDataList, setUploadedFiles, setImageDataList],
    );

    const baseChat = (
      <div
        ref={ref}
        className={cn(styles.BaseChat, 'relative flex flex-1 min-h-0 w-full overflow-hidden')}
        data-chat-visible={isHydrated ? String(showChat) : undefined}
        suppressHydrationWarning
      >
        <Suspense fallback={null}>
          <Menu />
        </Suspense>
        <div className="flex flex-row w-full h-full min-w-0 overflow-hidden">
          {/* Chat Panel - hidden when showChat is false and workbench is visible */}
          {showChat && (
            <div
              className={cn(styles.Chat, 'flex flex-col flex-grow min-w-[300px] min-h-0 h-full', {
                'select-none': isResizing,
                'overflow-hidden': chatStarted || inspectorActive,
                'overflow-y-auto': !chatStarted && !inspectorActive,
              })}
            >
              {/* Inspector Panel replaces chat content when active */}
              {inspectorActive ? (
                <InspectorPanelSlot />
              ) : (
                <>
                  {!chatStarted && (
                    <div id="intro" className="mt-[6vh] max-w-2xl mx-auto text-center px-4 lg:px-0 relative">
                      {/* Liquid Metal 3D Text */}
                      <div className="liquid-metal-container">
                        <h1 className="liquid-metal-text" aria-label="Devonz">
                          Devonz
                        </h1>
                      </div>

                      {/* Subtitle below the 3D text */}
                      <p className="text-base lg:text-lg text-[#8badd4] animate-fade-in animation-delay-200">
                        Build anything with AI. Just describe what you want.
                      </p>
                    </div>
                  )}
                  <StickToBottom
                    className={cn('pt-6 px-2 sm:px-6 relative', {
                      'h-full flex flex-col modern-scrollbar': chatStarted,
                    })}
                    resize="smooth"
                    initial="smooth"
                  >
                    <StickToBottom.Content className="flex flex-col gap-4 relative ">
                      {chatStarted ? (
                        <Suspense>
                          <Messages
                            key="messages-component"
                            className="flex flex-col w-full flex-1 max-w-chat pb-4 mx-auto z-1"
                            messages={messages}
                            isStreaming={isStreaming}
                            append={append}
                            chatMode={chatMode}
                            setChatMode={setChatMode}
                            provider={provider}
                            model={model}
                            addToolResult={addToolResult}
                          />
                        </Suspense>
                      ) : null}
                      <ScrollToBottom />
                    </StickToBottom.Content>
                    <div
                      className={cn('my-auto flex flex-col gap-2 w-full max-w-chat mx-auto z-prompt mb-6', {
                        'sticky bottom-2': chatStarted,
                      })}
                    >
                      <div className="flex flex-col gap-2">
                        <Suspense>
                          {deployAlert && (
                            <DeployChatAlert
                              alert={deployAlert}
                              clearAlert={() => clearDeployAlert?.()}
                              postMessage={(message: string | undefined) => {
                                sendMessage?.(undefined, message);
                                clearSupabaseAlert?.();
                              }}
                            />
                          )}
                          {supabaseAlert && (
                            <SupabaseChatAlert
                              alert={supabaseAlert}
                              clearAlert={() => clearSupabaseAlert?.()}
                              postMessage={(message) => {
                                sendMessage?.(undefined, message);
                                clearSupabaseAlert?.();
                              }}
                            />
                          )}
                          {actionAlert && (
                            <ChatAlert
                              alert={actionAlert}
                              clearAlert={() => clearAlert?.()}
                              postMessage={(message) => {
                                sendMessage?.(undefined, message);
                                clearAlert?.();
                              }}
                            />
                          )}
                          {llmErrorAlert && (
                            <LlmErrorAlert alert={llmErrorAlert} clearAlert={() => clearLlmErrorAlert?.()} />
                          )}
                        </Suspense>
                      </div>
                      {progressAnnotations && <ProgressCompilation data={progressAnnotations} />}

                      {/* 3-Column Layout Wrapper */}
                      <div className="flex items-center justify-center gap-4 lg:gap-6 w-full">
                        {/* Center Column - ChatBox */}
                        <div className="w-full max-w-chat">
                          <ChatBox
                            isModelSettingsCollapsed={isModelSettingsCollapsed}
                            setIsModelSettingsCollapsed={setIsModelSettingsCollapsed}
                            provider={provider}
                            setProvider={setProvider}
                            providerList={providerList || (PROVIDER_LIST as ProviderInfo[])}
                            model={model}
                            setModel={setModel}
                            modelList={modelList}
                            apiKeys={apiKeys}
                            isModelLoading={isModelLoading}
                            onApiKeysChange={onApiKeysChange}
                            uploadedFiles={uploadedFiles}
                            setUploadedFiles={setUploadedFiles}
                            imageDataList={imageDataList}
                            setImageDataList={setImageDataList}
                            textareaRef={textareaRef}
                            input={input}
                            handleInputChange={handleInputChange}
                            handlePaste={handlePaste}
                            TEXTAREA_MIN_HEIGHT={TEXTAREA_MIN_HEIGHT}
                            TEXTAREA_MAX_HEIGHT={TEXTAREA_MAX_HEIGHT}
                            isStreaming={isStreaming}
                            handleStop={handleStop}
                            handleSendMessage={handleSendMessage}
                            enhancingPrompt={enhancingPrompt}
                            enhancePrompt={enhancePrompt}
                            isListening={isListening}
                            startListening={startListening}
                            stopListening={stopListening}
                            chatStarted={chatStarted}
                            exportChat={exportChat}
                            qrModalOpen={qrModalOpen}
                            setQrModalOpen={setQrModalOpen}
                            handleFileUpload={handleFileUpload}
                            chatMode={chatMode}
                            setChatMode={setChatMode}
                            planMode={planMode}
                            setPlanMode={setPlanMode}
                            designScheme={designScheme}
                            setDesignScheme={setDesignScheme}
                            selectedElement={selectedElement}
                            setSelectedElement={setSelectedElement}
                            onWebSearchResult={onWebSearchResult}
                          />
                        </div>
                      </div>

                      {/* Secondary import/clone actions - below the prompt box */}
                      {!chatStarted && (
                        <div className="flex justify-center mt-2 max-w-chat mx-auto w-full">
                          <LeftActionPanel importChat={importChat} />
                        </div>
                      )}

                      {/* CLI agent console launchers - below import/clone actions */}
                      {!chatStarted && (
                        <div className="flex justify-center mt-1 max-w-chat mx-auto w-full">
                          <CliAgentLauncher />
                        </div>
                      )}
                    </div>
                  </StickToBottom>
                  {/* Template Gallery - Below Example Prompts */}
                  {!chatStarted && <TemplateSection />}
                </>
              )}
            </div>
          )}

          {/* Resize Handle - only show when workbench is visible and chat is shown */}
          {chatStarted && showWorkbench && showChat && (
            <ResizeHandle
              onResize={handleResize}
              onResizeStart={() => setIsResizing(true)}
              onResizeEnd={() => setIsResizing(false)}
            />
          )}

          {/* Workbench Panel */}
          <PanelErrorBoundary panelName="Workbench">
            <Suspense>
              <Workbench
                chatStarted={chatStarted}
                isStreaming={isStreaming}
                setSelectedElement={setSelectedElement}
                width={showChat ? workbenchWidth : undefined}
                fullWidth={!showChat}
              />
            </Suspense>
          </PanelErrorBoundary>
        </div>
      </div>
    );

    return <Tooltip.Provider delayDuration={200}>{baseChat}</Tooltip.Provider>;
  },
);

function ScrollToBottom() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  return (
    !isAtBottom && (
      <>
        <div className="sticky bottom-0 left-0 right-0 bg-gradient-to-t from-devonz-elements-background-depth-1 to-transparent h-20 z-10" />
        <button
          className="sticky z-50 bottom-0 left-0 right-0 text-4xl rounded-lg px-1.5 py-0.5 flex items-center justify-center mx-auto gap-2 bg-devonz-elements-background-depth-2 border border-devonz-elements-borderColor text-devonz-elements-textPrimary text-sm"
          onClick={() => scrollToBottom()}
        >
          Go to last message
          <span className="i-ph:arrow-down animate-bounce" />
        </button>
      </>
    )
  );
}
