import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { memo, useEffect, useMemo, useRef } from 'react';
import type { Theme } from '~/types/theme';
import { cn } from '~/utils/cn';
import { debounce } from '~/utils/debounce';
import { createScopedLogger } from '~/utils/logger';
import { isFileLocked, getCurrentChatId } from '~/utils/fileLocks';
import { BinaryContent } from '~/components/editor/codemirror/BinaryContent';
import type {
  EditorDocument,
  EditorSettings,
  OnChangeCallback,
  OnSaveCallback,
  OnScrollCallback,
} from '~/components/editor/codemirror/CodeMirrorEditor';

const logger = createScopedLogger('MonacoEditor');

const DARK_THEME = 'devonz-dark';
const LIGHT_THEME = 'vs';

let monacoConfigured = false;

export function ensureMonacoConfigured() {
  if (monacoConfigured) {
    return;
  }

  monacoConfigured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  monaco.editor.defineTheme(DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0d1117',
      'editorGutter.background': '#0d1117',
    },
  });

  /*
   * Generated projects have no node_modules inside the browser, so semantic
   * type-checking would flood the editor with false errors. Keep syntax
   * validation only.
   */
  const diagnosticsOptions = { noSemanticValidation: true, noSyntaxValidation: false };
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);

  const compilerOptions = {
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    allowJs: true,
    allowNonTsExtensions: true,
  };
  monaco.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  monaco.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
}

interface Props {
  theme: Theme;
  id?: unknown;
  doc?: EditorDocument;
  editable?: boolean;
  debounceChange?: number;
  debounceScroll?: number;
  autoFocusOnDocumentChange?: boolean;
  onChange?: OnChangeCallback;
  onScroll?: OnScrollCallback;
  onSave?: OnSaveCallback;
  className?: string;
  settings?: EditorSettings;
}

function toModelUri(filePath: string) {
  return monaco.Uri.file(filePath.startsWith('/') ? filePath : `/${filePath}`);
}

export const MonacoEditor = memo(
  ({
    theme,
    doc,
    editable = true,
    debounceChange = 150,
    debounceScroll = 100,
    autoFocusOnDocumentChange = false,
    onChange,
    onScroll,
    onSave,
    className,
    settings,
  }: Props) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
    const ownedModelsRef = useRef(new Set<string>());
    const currentFilePathRef = useRef<string | undefined>(undefined);
    const suppressChangeRef = useRef(false);

    const onChangeRef = useRef(onChange);
    const onScrollRef = useRef(onScroll);
    const onSaveRef = useRef(onSave);
    const docRef = useRef(doc);

    onChangeRef.current = onChange;
    onScrollRef.current = onScroll;
    onSaveRef.current = onSave;
    docRef.current = doc;

    const emitChange = useMemo(
      () =>
        debounce(() => {
          const editor = editorRef.current;
          const model = editor?.getModel();

          if (!editor || !model || docRef.current?.filePath !== currentFilePathRef.current) {
            return;
          }

          onChangeRef.current?.({ content: model.getValue() });
        }, debounceChange),
      [debounceChange],
    );

    const emitScroll = useMemo(
      () =>
        debounce((position: { top: number; left: number }) => {
          onScrollRef.current?.(position);
        }, debounceScroll),
      [debounceScroll],
    );

    // Create the editor once
    useEffect(() => {
      if (!containerRef.current) {
        return undefined;
      }

      ensureMonacoConfigured();

      const editor = monaco.editor.create(containerRef.current, {
        model: null,
        automaticLayout: true,
        fontSize: settings?.fontSize ? parseInt(settings.fontSize, 10) || 13 : 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: true,
        renderWhitespace: 'none',
        tabSize: settings?.tabSize ?? 2,
        theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
        readOnlyMessage: { value: 'Cannot edit file while AI response is being generated or the file is locked' },
        fixedOverflowWidgets: true,
        padding: { top: 4 },
      });
      editorRef.current = editor;

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSaveRef.current?.();
      });

      const changeDisposable = editor.onDidChangeModelContent(() => {
        if (suppressChangeRef.current) {
          return;
        }

        emitChange();
      });

      const scrollDisposable = editor.onDidScrollChange((event) => {
        emitScroll({ top: event.scrollTop, left: event.scrollLeft });
      });

      return () => {
        changeDisposable.dispose();
        scrollDisposable.dispose();
        editor.dispose();
        editorRef.current = null;

        for (const uriString of ownedModelsRef.current) {
          const model = monaco.editor.getModel(monaco.Uri.parse(uriString));
          model?.dispose();
        }

        ownedModelsRef.current.clear();
      };

      // Editor is intentionally created once; settings/theme changes are applied via updateOptions effects
    }, []);

    // Theme switching
    useEffect(() => {
      monaco.editor.setTheme(theme === 'dark' ? DARK_THEME : LIGHT_THEME);
    }, [theme]);

    // Document + content sync
    useEffect(() => {
      const editor = editorRef.current;

      if (!editor || !doc || doc.isBinary) {
        if (editor && (!doc || doc.isBinary)) {
          editor.setModel(null);
          currentFilePathRef.current = undefined;
        }

        return;
      }

      const uri = toModelUri(doc.filePath);
      let model = monaco.editor.getModel(uri);

      if (!model) {
        model = monaco.editor.createModel(doc.value, undefined, uri);
        model.updateOptions({ tabSize: settings?.tabSize ?? 2 });
        ownedModelsRef.current.add(uri.toString());
      }

      const previousFilePath = currentFilePathRef.current;

      if (previousFilePath && previousFilePath !== doc.filePath) {
        viewStatesRef.current.set(previousFilePath, editor.saveViewState());
      }

      if (editor.getModel() !== model) {
        editor.setModel(model);

        const cachedViewState = viewStatesRef.current.get(doc.filePath);

        if (cachedViewState) {
          editor.restoreViewState(cachedViewState);
        } else if (doc.scroll?.line !== undefined) {
          // Line-based jump (e.g. from Search); incoming line numbers are 0-based
          const lineNumber = doc.scroll.line + 1;
          const column = (doc.scroll.column ?? 0) + 1;
          editor.setPosition({ lineNumber, column });
          editor.revealLineInCenter(lineNumber);
        } else if (doc.scroll) {
          editor.setScrollPosition({ scrollTop: doc.scroll.top ?? 0, scrollLeft: doc.scroll.left ?? 0 });
        }

        if (autoFocusOnDocumentChange) {
          editor.focus();
        }
      } else if (doc.scroll?.line !== undefined && previousFilePath === doc.filePath) {
        // Same file re-selected with a jump target (Search result within the open file)
        const lineNumber = doc.scroll.line + 1;
        editor.setPosition({ lineNumber, column: (doc.scroll.column ?? 0) + 1 });
        editor.revealLineInCenter(lineNumber);
      }

      currentFilePathRef.current = doc.filePath;

      // External content changes (AI streaming writes, file reset) must update the model
      if (model.getValue() !== doc.value) {
        suppressChangeRef.current = true;

        try {
          model.pushEditOperations([], [{ range: model.getFullModelRange(), text: doc.value }], () => null);
        } catch (error) {
          logger.error('Failed to sync external content', error);
        } finally {
          suppressChangeRef.current = false;
        }
      }
    }, [doc?.filePath, doc?.value, doc?.isBinary, doc?.scroll, autoFocusOnDocumentChange]);

    // Read-only state
    useEffect(() => {
      const editor = editorRef.current;

      if (!editor) {
        return;
      }

      let locked = false;

      if (doc?.filePath) {
        try {
          locked = isFileLocked(doc.filePath, getCurrentChatId()).locked;
        } catch {
          locked = false;
        }
      }

      editor.updateOptions({ readOnly: !editable || !doc || doc.isBinary || locked });
    }, [editable, doc?.filePath, doc?.isBinary, doc]);

    return (
      <div className={cn('relative h-full', className)} style={{ background: 'var(--cm-backgroundColor, #0d1117)' }}>
        {doc?.isBinary && <BinaryContent />}
        <div ref={containerRef} className="h-full" data-testid="monaco-editor-container" />
      </div>
    );
  },
);

MonacoEditor.displayName = 'MonacoEditor';
