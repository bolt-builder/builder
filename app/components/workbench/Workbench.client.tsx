import { useStore } from '@nanostores/react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { computed } from 'nanostores';
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { IChatMetadata } from '~/lib/persistence/db';
import {
  type OnChangeCallback as OnEditorChange,
  type OnScrollCallback as OnEditorScroll,
} from '~/components/editor/codemirror/CodeMirrorEditor';
import { Slider, type SliderOptions } from '~/components/ui/Slider';
import { workbenchStore, type WorkbenchViewType } from '~/lib/stores/workbench';
import { cn } from '~/utils/cn';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import { EditorPanel } from './EditorPanel';

const Preview = lazy(() => import('./Preview').then((m) => ({ default: m.Preview })));
const BrowserPanel = lazy(() => import('./BrowserPanel').then((m) => ({ default: m.BrowserPanel })));
const Versions = lazy(() => import('./Versions').then((m) => ({ default: m.Versions })));
const Plan = lazy(() => import('./Plan').then((m) => ({ default: m.Plan })));
const StagedChangesPanel = lazy(() => import('./StagedChangesPanel').then((m) => ({ default: m.StagedChangesPanel })));
const DiffPreviewModal = lazy(() => import('./DiffPreviewModal').then((m) => ({ default: m.DiffPreviewModal })));
import useViewport from '~/lib/hooks';

import { chatStore } from '~/lib/stores/chat';
import type { ElementInfo } from './inspector-types';
import { ExportChatButton } from '~/components/chat/chatExportAndImport/ExportChatButton';
import { useChatHistory } from '~/lib/persistence';
import { streamingState } from '~/lib/stores/streaming';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { usePlanSync } from '~/lib/hooks/usePlanSync';
import { runtime } from '~/lib/runtime';
import { WORK_DIR } from '~/utils/constants';

const workbenchLogger = createScopedLogger('Workbench');

interface WorkspaceProps {
  chatStarted?: boolean;
  isStreaming?: boolean;
  metadata?: {
    gitUrl?: string;
  };
  updateChatMetaData?: (metadata: IChatMetadata) => void;
  setSelectedElement?: (element: ElementInfo | null) => void;

  /** The width of the workbench panel in pixels */
  width?: number;

  /** Whether the workbench should take full width (when chat is hidden) */
  fullWidth?: boolean;
}

const viewTransition = { ease: cubicEasingFn };

const sliderOptions: SliderOptions<WorkbenchViewType> = {
  left: {
    value: 'code',
    text: 'Code',
    icon: 'i-ph:code-bold',
  },
  middle: {
    value: 'preview',
    text: 'Preview',
    icon: 'i-ph:monitor-play',
  },
  right: {
    value: 'browser',
    text: 'Browser',
    icon: 'i-ph:globe-simple',
  },
};

export const Workbench = memo(({ chatStarted, isStreaming, setSelectedElement, width, fullWidth }: WorkspaceProps) => {
  renderLogger.trace('Workbench');

  const hasPreview = useStore(computed(workbenchStore.previews, (previews) => previews.length > 0));
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const selectedFile = useStore(workbenchStore.selectedFile);
  const currentDocument = useStore(workbenchStore.currentDocument);
  const unsavedFiles = useStore(workbenchStore.unsavedFiles);
  const selectedView = useStore(workbenchStore.currentView);
  const showTerminal = useStore(workbenchStore.showTerminal);
  const { showChat } = useStore(chatStore);
  const canHideChat = showWorkbench || !showChat;

  // Sync PLAN.md content from project files into the plan store
  usePlanSync();

  const isSmallViewport = useViewport(1024);
  const streaming = useStore(streamingState);
  const { exportChat } = useChatHistory();
  const [isSyncing, setIsSyncing] = useState(false);
  const previewStore = workbenchStore.previewsStore;

  // Auto-refresh preview 2 seconds after LLM response completes
  const prevStreamingRef = useRef(streaming);

  useEffect(() => {
    if (prevStreamingRef.current && !streaming) {
      const timer = setTimeout(() => {
        previewStore.refreshAllPreviews();

        /*
         * Auto-start static server fallback:
         * If no start action was run and no previews exist, serve static files
         */
        const previews = workbenchStore.previews.get();
        const artifacts = workbenchStore.artifacts.get();
        const hasStartAction = Object.values(artifacts).some((artifact) =>
          Object.values(artifact.runner.actions.get()).some((action) => action.type === 'start'),
        );

        if (!hasStartAction && previews.length === 0) {
          const currentFiles = workbenchStore.files.get();

          const hasPackageJson = Object.keys(currentFiles).some(
            (filePath) => filePath.endsWith('/package.json') && currentFiles[filePath]?.type === 'file',
          );

          const hasShellAction = Object.values(artifacts).some((artifact) =>
            Object.values(artifact.runner.actions.get()).some((action) => action.type === 'shell'),
          );

          if (hasPackageJson && !hasShellAction) {
            workbenchLogger.info(
              'No shell/start action found with package.json — auto-installing and starting dev server',
            );

            let devCommand = 'npm run dev';

            try {
              const pkgEntry = Object.entries(currentFiles).find(([k]) => k.endsWith('/package.json'));

              if (pkgEntry && pkgEntry[1]?.type === 'file') {
                const pkg = JSON.parse(pkgEntry[1].content || '{}');

                if (pkg.scripts?.dev) {
                  devCommand = 'npm run dev';
                } else if (pkg.scripts?.start) {
                  devCommand = 'npm start';
                } else if (pkg.scripts?.preview) {
                  devCommand = 'npm run preview';
                }
              }
            } catch (e) {
              workbenchLogger.debug('Failed to parse package.json for dev command detection:', e);
            }

            const shell = workbenchStore.devonzTerminal;

            shell
              .ready()
              .then(async () => {
                try {
                  await shell.executeCommand('auto-start-install', 'npm install --legacy-peer-deps');
                  shell.executeCommand('auto-start-dev', devCommand);
                } catch (err) {
                  workbenchLogger.error('Auto-start failed:', err);
                }
              })
              .catch((err) => {
                workbenchLogger.error('Shell ready failed:', err);
              });
          } else if (!hasPackageJson) {
            const hasIndexHtml = Object.keys(currentFiles).some(
              (filePath) => filePath.endsWith('/index.html') && currentFiles[filePath]?.type === 'file',
            );

            if (hasIndexHtml) {
              workbenchLogger.info('No start action found — launching static file server for index.html');

              runtime.then((rt) => {
                rt.spawn('npx', ['--yes', 'serve', '.'], {
                  cwd: WORK_DIR,
                  env: { NODE_ENV: 'development' },
                }).catch((err) => {
                  workbenchLogger.error('Failed to start static file server:', err);
                });
              });
            }
          }
        }
      }, 2000);

      prevStreamingRef.current = streaming;

      return () => clearTimeout(timer);
    }

    prevStreamingRef.current = streaming;

    return undefined;
  }, [streaming]);

  const setSelectedView = (view: WorkbenchViewType) => {
    workbenchStore.currentView.set(view);
  };

  useEffect(() => {
    if (hasPreview) {
      setSelectedView('preview');
    }
  }, [hasPreview]);

  const onEditorChange = useCallback<OnEditorChange>((update) => {
    workbenchStore.setCurrentDocumentContent(update.content);
  }, []);

  const onEditorScroll = useCallback<OnEditorScroll>((position) => {
    workbenchStore.setCurrentDocumentScrollPosition(position);
  }, []);

  const onFileSelect = useCallback((filePath: string | undefined) => {
    workbenchStore.setSelectedFile(filePath);
  }, []);

  const onFileSave = useCallback(() => {
    workbenchStore
      .saveCurrentDocument()
      .then(() => {
        // Explicitly refresh all previews after a file save
        previewStore.refreshAllPreviews();
      })
      .catch(() => {
        toast.error('Failed to update file content');
      });
  }, []);

  const onFileReset = useCallback(() => {
    workbenchStore.resetCurrentDocument();
  }, []);

  const handleSyncFiles = useCallback(async () => {
    setIsSyncing(true);

    try {
      const directoryHandle = await window.showDirectoryPicker();
      await workbenchStore.syncFiles(directoryHandle);
      toast.success('Files synced successfully');
    } catch (error) {
      workbenchLogger.error('Error syncing files:', error);
      toast.error('Failed to sync files');
    } finally {
      setIsSyncing(false);
    }
  }, []);

  return (
    chatStarted &&
    showWorkbench && (
      <div
        className={cn('h-full z-workbench min-w-0', {
          'flex-grow': !!fullWidth,
          'flex-shrink-0': !fullWidth,
        })}
        style={fullWidth ? undefined : { width: width || 'var(--workbench-width)', maxWidth: '100%' }}
      >
        <div
          className={cn('h-full flex flex-col bg-devonz-elements-background-depth-2 overflow-hidden', {
            'border-l border-devonz-elements-borderColor': !fullWidth,
          })}
        >
          <div className="flex items-center h-13 min-h-13 px-3.5 border-b border-devonz-elements-borderColor gap-2.5 bg-devonz-elements-background-depth-2/80">
            <button
              aria-label="Toggle file explorer"
              title="Toggle chat panel"
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-transparent text-devonz-elements-textSecondary hover:text-devonz-elements-textPrimary hover:bg-devonz-elements-background-depth-3 transition-colors"
              disabled={!canHideChat || isSmallViewport}
              onClick={() => {
                if (canHideChat) {
                  chatStore.setKey('showChat', !showChat);
                }
              }}
            >
              <span className={`${showChat ? 'i-ph:sidebar-simple-fill' : 'i-ph:sidebar-simple'} text-lg block`} />
            </button>
            <Slider selected={selectedView} options={sliderOptions} setSelected={setSelectedView} />

            <div className="ml-auto" />
            {selectedView === 'code' && (
              <div className="flex items-center gap-1 overflow-y-auto">
                {/* Export Chat Button */}
                <ExportChatButton exportChat={exportChat} />

                {/* Sync Button */}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger
                    disabled={isSyncing || streaming}
                    title="Sync files"
                    aria-label="Sync files"
                    className="w-9 h-9 flex items-center justify-center rounded-lg bg-transparent text-devonz-elements-textSecondary hover:text-devonz-elements-textPrimary hover:bg-devonz-elements-background-depth-3 [&:is(:disabled,.disabled)]:cursor-not-allowed [&:is(:disabled,.disabled)]:opacity-50 outline-accent-500 transition-colors"
                  >
                    <span className={cn('text-lg block', isSyncing ? 'i-ph:spinner animate-spin' : 'i-ph:swap')} />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className={cn(
                        'min-w-[240px] z-[9999]',
                        'bg-devonz-elements-background-depth-2',
                        'rounded-lg shadow-lg',
                        'border border-devonz-elements-borderColor',
                        'animate-in fade-in-0 zoom-in-95',
                        'py-1',
                      )}
                      sideOffset={5}
                      align="end"
                    >
                      <DropdownMenu.Item
                        className={cn(
                          'cursor-pointer flex items-center w-full px-4 py-2 text-sm text-devonz-elements-textPrimary hover:bg-devonz-elements-item-backgroundActive gap-2 rounded-md group relative',
                        )}
                        onClick={handleSyncFiles}
                        disabled={isSyncing}
                      >
                        <div className="flex items-center gap-2">
                          {isSyncing ? <div className="i-ph:spinner" /> : <div className="i-ph:cloud-arrow-down" />}
                          <span>{isSyncing ? 'Syncing...' : 'Sync Files'}</span>
                        </div>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>

                {/* Toggle Terminal Button */}
                <button
                  onClick={() => {
                    workbenchStore.toggleTerminal(!workbenchStore.showTerminal.get());
                  }}
                  title="Toggle terminal"
                  aria-label="Toggle terminal"
                  className={cn(
                    'w-9 h-9 flex items-center justify-center rounded-lg bg-transparent transition-colors outline-accent-500',
                    showTerminal
                      ? 'text-accent-500 bg-devonz-elements-background-depth-3'
                      : 'text-devonz-elements-textSecondary hover:text-devonz-elements-textPrimary hover:bg-devonz-elements-background-depth-3',
                  )}
                >
                  <span className="i-ph:terminal-window text-lg block" />
                </button>
              </div>
            )}

            <button
              aria-label="Close workbench"
              title="Close workbench"
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-transparent text-devonz-elements-textSecondary hover:text-devonz-elements-textPrimary hover:bg-devonz-elements-background-depth-3 transition-colors"
              onClick={() => {
                workbenchStore.showWorkbench.set(false);
              }}
            >
              <span className="i-ph:x text-lg block" />
            </button>
          </div>
          {/* Plan component - shows when planning is active */}
          <Suspense fallback={null}>
            <Plan />
          </Suspense>
          {/* Staged changes panel - shows pending file changes */}
          <Suspense fallback={null}>
            <StagedChangesPanel />
          </Suspense>
          {/* Diff preview modal - for reviewing individual changes */}
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin w-8 h-8 border-2 border-devonz-elements-item-contentAccent border-t-transparent rounded-full" />
              </div>
            }
          >
            <DiffPreviewModal />
          </Suspense>
          <div className="relative flex-1 overflow-hidden">
            <View initial={{ x: '0%' }} animate={{ x: selectedView === 'code' ? '0%' : '-100%' }}>
              <EditorPanel
                editorDocument={currentDocument}
                isStreaming={isStreaming}
                selectedFile={selectedFile}
                unsavedFiles={unsavedFiles}
                onFileSelect={onFileSelect}
                onEditorScroll={onEditorScroll}
                onEditorChange={onEditorChange}
                onFileSave={onFileSave}
                onFileReset={onFileReset}
              />
            </View>
            <View
              initial={{ x: '100%' }}
              animate={{ x: selectedView === 'preview' ? '0%' : selectedView === 'code' ? '100%' : '-100%' }}
            >
              <Suspense>
                <Preview setSelectedElement={setSelectedElement} />
              </Suspense>
            </View>
            <View initial={{ x: '100%' }} animate={{ x: selectedView === 'browser' ? '0%' : '100%' }}>
              <Suspense>
                <BrowserPanel />
              </Suspense>
            </View>
            <View initial={{ x: '100%' }} animate={{ x: selectedView === 'versions' ? '0%' : '100%' }}>
              <Suspense>
                <Versions />
              </Suspense>
            </View>
          </div>
        </div>
      </div>
    )
  );
});

// View component for rendering content with motion transitions
interface ViewProps extends HTMLMotionProps<'div'> {
  children: JSX.Element;
}

const View = memo(({ children, ...props }: ViewProps) => {
  return (
    <motion.div className="absolute inset-0" transition={viewTransition} {...props}>
      {children}
    </motion.div>
  );
});
