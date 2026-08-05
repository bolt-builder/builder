import { useStore } from '@nanostores/react';
import { lazy, memo, Suspense, useDeferredValue, useMemo } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import * as Tabs from '@radix-ui/react-tabs';
import {
  CodeMirrorEditor,
  type EditorDocument,
  type EditorSettings,
  type OnChangeCallback as OnEditorChange,
  type OnSaveCallback as OnEditorSave,
  type OnScrollCallback as OnEditorScroll,
} from '~/components/editor/codemirror/CodeMirrorEditor';
import { PanelHeader } from '~/components/ui/PanelHeader';
import { PanelHeaderButton } from '~/components/ui/PanelHeaderButton';
import type { FileHistory } from '~/types/actions';
import { themeStore } from '~/lib/stores/theme';
import { WORK_DIR } from '~/utils/constants';
import { renderLogger } from '~/utils/logger';
import { isMobile } from '~/utils/mobile';
import { FileBreadcrumb } from './FileBreadcrumb';
import { FileTree } from './FileTree';
import { DEFAULT_TERMINAL_SIZE, TerminalTabs } from './terminal/TerminalTabs';
import { workbenchStore } from '~/lib/stores/workbench';
import { useMonacoEditorStore } from '~/lib/stores/settings';
import { fileGenerationStatus } from '~/lib/stores/files';
import { Search } from './Search';
import { cn } from '~/utils/cn';
import { LockManager } from './LockManager';

interface EditorPanelProps {
  unsavedFiles?: Set<string>;
  editorDocument?: EditorDocument;
  selectedFile?: string | undefined;
  isStreaming?: boolean;
  fileHistory?: Record<string, FileHistory>;
  onEditorChange?: OnEditorChange;
  onEditorScroll?: OnEditorScroll;
  onFileSelect?: (value?: string) => void;
  onFileSave?: OnEditorSave;
  onFileReset?: () => void;
}

const DEFAULT_EDITOR_SIZE = 100 - DEFAULT_TERMINAL_SIZE;

const editorSettings: EditorSettings = { tabSize: 2 };

const MonacoEditor = lazy(() =>
  import('~/components/editor/monaco/MonacoEditor').then((module) => ({ default: module.MonacoEditor })),
);

const editorLoadingFallback = (
  <div className="flex items-center justify-center h-full text-devonz-elements-textTertiary">
    <span className="i-svg-spinners:90-ring-with-bg text-xl" />
  </div>
);

export const EditorPanel = memo(
  ({
    unsavedFiles,
    editorDocument,
    selectedFile,
    isStreaming,
    fileHistory,
    onFileSelect,
    onEditorChange,
    onEditorScroll,
    onFileSave,
    onFileReset,
  }: EditorPanelProps) => {
    const files = useStore(workbenchStore.files);
    renderLogger.trace('EditorPanel');

    const theme = useStore(themeStore);
    const showTerminal = useStore(workbenchStore.showTerminal);

    const useMonaco = useStore(useMonacoEditorStore);
    const rawGenStatus = useStore(fileGenerationStatus);
    const genStatus = useDeferredValue(rawGenStatus);
    const isFileGenerating = editorDocument ? genStatus[editorDocument.filePath] === 'generating' : false;

    const activeFileSegments = useMemo(() => {
      if (!editorDocument) {
        return undefined;
      }

      return editorDocument.filePath.split('/');
    }, [editorDocument]);

    const activeFileUnsaved = useMemo(() => {
      if (!editorDocument || !unsavedFiles) {
        return false;
      }

      // Make sure unsavedFiles is a Set before calling has()
      return unsavedFiles instanceof Set && unsavedFiles.has(editorDocument.filePath);
    }, [editorDocument, unsavedFiles]);

    return (
      <PanelGroup direction="vertical">
        <Panel defaultSize={showTerminal ? DEFAULT_EDITOR_SIZE : 100} minSize={20}>
          <PanelGroup direction="horizontal">
            <Panel
              defaultSize={20}
              minSize={15}
              collapsible
              className="border-r border-devonz-elements-borderColor"
              style={{ background: 'var(--devonz-elements-bg-depth-1)' }}
            >
              <div className="h-full">
                <Tabs.Root defaultValue="files" className="flex flex-col h-full">
                  <PanelHeader className="w-full text-sm font-medium text-devonz-elements-textSecondary px-1">
                    <div className="h-full flex-shrink-0 flex items-center justify-between w-full">
                      <Tabs.List className="h-full flex-shrink-0 flex items-center gap-1">
                        <Tabs.Trigger
                          value="files"
                          title="Files"
                          aria-label="Files"
                          className={cn(
                            'h-full bg-transparent hover:bg-devonz-elements-background-depth-3 p-1.5 rounded-lg text-devonz-elements-textTertiary hover:text-devonz-elements-textPrimary data-[state=active]:text-devonz-elements-textPrimary',
                          )}
                        >
                          <div className="i-ph:files text-lg" />
                        </Tabs.Trigger>
                        <Tabs.Trigger
                          value="search"
                          title="Search"
                          aria-label="Search"
                          className={cn(
                            'h-full bg-transparent hover:bg-devonz-elements-background-depth-3 p-1.5 rounded-lg text-devonz-elements-textTertiary hover:text-devonz-elements-textPrimary data-[state=active]:text-devonz-elements-textPrimary',
                          )}
                        >
                          <div className="i-ph:magnifying-glass text-lg" />
                        </Tabs.Trigger>
                        <Tabs.Trigger
                          value="locks"
                          title="Locks"
                          aria-label="Locks"
                          className={cn(
                            'h-full bg-transparent hover:bg-devonz-elements-background-depth-3 p-1.5 rounded-lg text-devonz-elements-textTertiary hover:text-devonz-elements-textPrimary data-[state=active]:text-devonz-elements-textPrimary',
                          )}
                        >
                          <div className="i-ph:lock text-lg" />
                        </Tabs.Trigger>
                      </Tabs.List>
                    </div>
                  </PanelHeader>

                  <Tabs.Content
                    value="files"
                    className="flex-grow overflow-auto focus-visible:outline-none"
                    style={{ background: 'var(--devonz-elements-bg-depth-1)' }}
                  >
                    <FileTree
                      className="h-full"
                      files={files}
                      hideRoot
                      unsavedFiles={unsavedFiles}
                      fileHistory={fileHistory}
                      rootFolder={WORK_DIR}
                      selectedFile={selectedFile}
                      onFileSelect={onFileSelect}
                    />
                  </Tabs.Content>

                  <Tabs.Content
                    value="search"
                    className="flex-grow overflow-auto focus-visible:outline-none"
                    style={{ background: 'var(--devonz-elements-bg-depth-1)' }}
                  >
                    <Search />
                  </Tabs.Content>

                  <Tabs.Content
                    value="locks"
                    className="flex-grow overflow-auto focus-visible:outline-none"
                    style={{ background: 'var(--devonz-elements-bg-depth-1)' }}
                  >
                    <LockManager />
                  </Tabs.Content>
                </Tabs.Root>
              </div>
            </Panel>

            <PanelResizeHandle />
            <Panel
              className="flex flex-col"
              defaultSize={80}
              minSize={20}
              style={{ background: 'var(--devonz-elements-bg-depth-1)' }}
            >
              <PanelHeader className="overflow-x-auto">
                {activeFileSegments?.length && (
                  <div className="flex items-center flex-1 text-sm">
                    <FileBreadcrumb pathSegments={activeFileSegments} files={files} onFileSelect={onFileSelect} />
                    {activeFileUnsaved && (
                      <div className="flex gap-1 ml-auto -mr-1.5">
                        <PanelHeaderButton onClick={onFileSave}>
                          <div className="i-ph:floppy-disk-duotone" />
                          Save
                        </PanelHeaderButton>
                        <PanelHeaderButton onClick={onFileReset}>
                          <div className="i-ph:clock-counter-clockwise-duotone" />
                          Reset
                        </PanelHeaderButton>
                      </div>
                    )}
                  </div>
                )}
              </PanelHeader>
              <div className="flex-1 overflow-hidden relative">
                {isFileGenerating && (
                  <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-accent-500/15 text-accent-500 text-xs font-medium border-b border-accent-500/25">
                    <span className="i-svg-spinners:90-ring-with-bg shrink-0" />
                    Generating…
                  </div>
                )}
                {/* .env files stay on CodeMirror for secret-value masking parity */}
                {useMonaco && !editorDocument?.filePath.includes('.env') ? (
                  <Suspense fallback={editorLoadingFallback}>
                    <MonacoEditor
                      theme={theme}
                      editable={!isStreaming && editorDocument !== undefined}
                      settings={editorSettings}
                      doc={editorDocument}
                      autoFocusOnDocumentChange={!isMobile()}
                      onScroll={onEditorScroll}
                      onChange={onEditorChange}
                      onSave={onFileSave}
                    />
                  </Suspense>
                ) : (
                  <CodeMirrorEditor
                    theme={theme}
                    editable={!isStreaming && editorDocument !== undefined}
                    settings={editorSettings}
                    doc={editorDocument}
                    autoFocusOnDocumentChange={!isMobile()}
                    onScroll={onEditorScroll}
                    onChange={onEditorChange}
                    onSave={onFileSave}
                  />
                )}
              </div>
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle />
        <TerminalTabs />
      </PanelGroup>
    );
  },
);
