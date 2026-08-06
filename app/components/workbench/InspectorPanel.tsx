/**
 * Element Inspector detail panel.
 *
 * Consumes the `UseInspectorReturn` API returned by `useInspector()` as
 * a single prop, eliminating the previous 17-prop interface. All state is
 * read from the hook (backed by nanostores) and all commands are
 * dispatched through the hook's typed action functions.
 *
 * @module workbench/InspectorPanel
 */

import { useState, useCallback, useRef, useEffect, memo } from 'react';
import type { UseInspectorReturn } from '~/lib/hooks/useInspector';
import type { InspectorTab } from '~/lib/inspector/types';
import { setPendingChatMessage } from '~/lib/stores/chat';
import { sanitizeForPrompt } from '~/utils/sanitize';
import { buildElementSelector } from '~/utils/selector';
import { COPY_FEEDBACK_TIMEOUT_MS, TEXT_PREVIEW_LENGTH } from '~/lib/inspector/constants';
import { BulkStyleSelector } from './BulkStyleSelector';
import { ThemeEditor } from './ThemeEditor';
import { StylesTabContent, BoxTabContent, AiTabContent } from './inspector';

/* ─── Tab config ───────────────────────────────────────────────────── */

const TABS: InspectorTab[] = ['styles', 'box', 'theme', 'ai'];

const TAB_LABELS: Record<InspectorTab, string> = {
  styles: 'Design',
  box: 'Box',
  theme: 'Theme',
  ai: 'AI',
};

const TAB_ICONS: Record<InspectorTab, string> = {
  styles: 'i-ph:palette',
  box: 'i-ph:squares-four',
  theme: 'i-ph:swatches',
  ai: 'i-ph:magic-wand',
};

/* ─── Props ────────────────────────────────────────────────────────── */

interface InspectorPanelProps {
  /** The full return value from `useInspector()`. */
  inspector: UseInspectorReturn;
}

/* ─── Component ────────────────────────────────────────────────────── */

export const InspectorPanel = memo(({ inspector }: InspectorPanelProps) => {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear copy-feedback timer on unmount
  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  const {
    selectedElement,
    activeTab,
    pendingEdits,
    pendingTextEdit,
    bulkTarget,
    accumulatedBulkChanges,
    bulkAffectedCount,
  } = inspector;

  /* ── Style / text routing ──────────────────────────────────────── */

  const handleStyleChange = useCallback(
    (property: string, value: string) => {
      if (bulkTarget) {
        inspector.bulkStyleChange(bulkTarget.selector, property, value);
      } else {
        inspector.editStyle(property, value);
      }
    },
    [inspector, bulkTarget],
  );

  const handleTextChange = useCallback(
    (text: string) => {
      inspector.editText(text);
    },
    [inspector],
  );

  /* ── Derived state ─────────────────────────────────────────────── */

  const hasChanges = Object.keys(pendingEdits).length > 0 || pendingTextEdit.length > 0;

  /* ── Image editing ─────────────────────────────────────────────── */

  const handleImageSrcChange = useCallback(
    (src: string) => {
      inspector.editAttribute('src', src);
    },
    [inspector],
  );

  const handleImageAltChange = useCallback(
    (alt: string) => {
      inspector.editAttribute('alt', alt);
    },
    [inspector],
  );

  const handleBackgroundImageChange = useCallback(
    (value: string) => {
      inspector.editStyle('background-image', value);
    },
    [inspector],
  );

  /* ── Clipboard ─────────────────────────────────────────────────── */

  const handleCopyCSS = useCallback(async () => {
    const ok = await inspector.copyCSS();
    setCopyFeedback(ok ? 'Copied!' : 'No changes to copy');

    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }

    copyFeedbackTimeoutRef.current = setTimeout(() => setCopyFeedback(null), COPY_FEEDBACK_TIMEOUT_MS);
  }, [inspector]);

  const handleCopyAllStyles = useCallback(async () => {
    const ok = await inspector.copyAllStyles();
    setCopyFeedback(ok ? 'All styles copied!' : 'No styles to copy');

    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }

    copyFeedbackTimeoutRef.current = setTimeout(() => setCopyFeedback(null), COPY_FEEDBACK_TIMEOUT_MS);
  }, [inspector]);

  /* ── Revert routing ────────────────────────────────────────────── */

  const handleRevert = useCallback(() => {
    if (bulkTarget) {
      inspector.revertBulk(bulkTarget.selector);
    } else {
      inspector.revert();
    }
  }, [inspector, bulkTarget]);

  /* ── AI action handler (for AiQuickActions sub-component) ──────── */

  const handleAIAction = useCallback(
    (message: string) => {
      setPendingChatMessage(message);
      inspector.closePanel();
    },
    [inspector],
  );

  /* ── Delete handler ────────────────────────────────────────────── */

  const handleDeleteElement = useCallback(() => {
    if (!selectedElement) {
      return;
    }

    const selector = buildElementSelector(selectedElement);

    const textPreview = sanitizeForPrompt(
      selectedElement.textContent?.slice(0, TEXT_PREVIEW_LENGTH) || '',
      TEXT_PREVIEW_LENGTH,
    );
    const textContext = textPreview
      ? ` with text "${textPreview}${selectedElement.textContent && selectedElement.textContent.length > TEXT_PREVIEW_LENGTH ? '...' : ''}"`
      : '';

    const message = `Please delete/remove the element \`${selector}\`${textContext} from the source code.\n\nRemove this element completely from the JSX/HTML.`;

    setPendingChatMessage(message);
    inspector.closePanel();
  }, [selectedElement, inspector]);

  /* ── Tab keyboard navigation (WAI-ARIA Tabs pattern) ────────── */

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = TABS.indexOf(activeTab);
      let newIndex: number | null = null;

      switch (e.key) {
        case 'ArrowRight':
          newIndex = (currentIndex + 1) % TABS.length;
          break;
        case 'ArrowLeft':
          newIndex = (currentIndex - 1 + TABS.length) % TABS.length;
          break;
        case 'Home':
          newIndex = 0;
          break;
        case 'End':
          newIndex = TABS.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();

      const newTab = TABS[newIndex];
      inspector.setActiveTab(newTab);

      const tabElement = document.getElementById(`inspector-tab-${newTab}`);
      tabElement?.focus();
    },
    [activeTab, inspector],
  );

  /* ── Early return ──────────────────────────────────────────────── */

  if (!selectedElement) {
    return (
      <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-2 items-center justify-center p-6 text-center">
        <div className="i-ph:cursor-click text-4xl text-bolt-elements-textSecondary mb-3" />
        <h3 className="text-sm font-medium text-bolt-elements-textPrimary mb-1">No Element Selected</h3>
        <p className="text-xs text-bolt-elements-textSecondary max-w-[200px]">
          Click on any element in the preview to inspect and edit its styles
        </p>
      </div>
    );
  }

  /* ── Render ────────────────────────────────────────────────────── */

  return (
    <div
      className="flex flex-col h-full w-full bg-bolt-elements-background-depth-2 overflow-hidden"
      role="region"
      aria-label="Element Inspector"
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-3">
        <div className="flex items-center gap-2">
          <div className="i-ph:cursor-click text-accent-400" aria-hidden="true" />
          <h3 className="font-medium text-bolt-elements-textPrimary text-sm">Inspector</h3>
        </div>
        <button
          onClick={inspector.closePanel}
          className="text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors p-1 rounded hover:bg-bolt-elements-background-depth-4"
          aria-label="Close inspector panel"
        >
          <div className="i-ph:x w-4 h-4" />
        </button>
      </div>

      {/* Element info badge */}
      <section
        aria-label="Selected element"
        className="p-3 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2"
      >
        <div className="font-mono text-xs bg-bolt-elements-background-depth-3 px-2 py-1.5 rounded border border-bolt-elements-borderColor flex items-center gap-1 flex-wrap">
          <span className="text-blue-400">{selectedElement.tagName.toLowerCase()}</span>
          {selectedElement.id && <span className="text-green-400">#{selectedElement.id}</span>}
          {selectedElement.className && (
            <span className="text-yellow-400">.{selectedElement.className.split(' ')[0]}</span>
          )}
          {selectedElement.rect && (
            <span className="text-bolt-elements-textSecondary ml-auto">
              {Math.round(selectedElement.rect.width)} &times; {Math.round(selectedElement.rect.height)}
            </span>
          )}
        </div>

        {/* Image info */}
        {selectedElement.isImage && selectedElement.imageSrc && (
          <div className="mt-2 flex items-center gap-2 p-2 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3">
            <div className="i-ph:image text-purple-400 w-4 h-4 shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0 text-xs">
              <p className="text-bolt-elements-textPrimary truncate" title={selectedElement.imageSrc}>
                {selectedElement.imageSrc.split('/').pop() || selectedElement.imageSrc}
              </p>
              {selectedElement.imageNaturalWidth != null && selectedElement.imageNaturalHeight != null && (
                <p className="text-bolt-elements-textSecondary">
                  {selectedElement.imageNaturalWidth} &times; {selectedElement.imageNaturalHeight} native
                </p>
              )}
              {selectedElement.imageAlt && (
                <p className="text-bolt-elements-textSecondary truncate" title={selectedElement.imageAlt}>
                  alt: {selectedElement.imageAlt}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Source file link — click to open in editor */}
        {selectedElement.sourceFile && (
          <button
            onClick={() =>
              inspector.navigateToSource(selectedElement.sourceFile!, selectedElement.sourceLine ?? undefined)
            }
            className="mt-2 flex items-center gap-2 text-xs text-accent-400 hover:text-accent-300 transition-colors w-full text-left group"
            title={`Open ${selectedElement.sourceFile}${selectedElement.sourceLine != null ? `:${selectedElement.sourceLine}` : ''} in editor`}
            aria-label={`Open source file ${selectedElement.sourceFile}${selectedElement.sourceLine != null ? ` at line ${selectedElement.sourceLine}` : ''}`}
          >
            <div className="i-ph:file-code w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {selectedElement.sourceFile}
              {selectedElement.sourceLine != null && `:${selectedElement.sourceLine}`}
            </span>
            <div
              className="i-ph:arrow-square-out w-3 h-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-hidden="true"
            />
          </button>
        )}
      </section>

      {/* Bulk style selector */}
      <div className="p-3 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
        <BulkStyleSelector
          currentTagName={selectedElement.tagName}
          selectedTarget={bulkTarget}
          onSelectTarget={inspector.setBulkTarget}
          affectedCount={bulkAffectedCount}
        />
      </div>

      {/* Tabs */}
      <div
        className="flex border-b border-bolt-elements-borderColor"
        style={{ background: 'var(--bolt-elements-bg-depth-3)' }}
        role="tablist"
        aria-label="Inspector tabs"
        onKeyDown={handleTabKeyDown}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            id={`inspector-tab-${tab}`}
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`inspector-tabpanel-${tab}`}
            tabIndex={activeTab === tab ? 0 : -1}
            onClick={() => inspector.setActiveTab(tab)}
            className="flex-1 flex items-center justify-center gap-1.5 px-1.5 py-2 text-[10px] font-medium capitalize transition-colors"
            style={{
              background: activeTab === tab ? 'var(--bolt-elements-bg-depth-2)' : 'transparent',
              color: activeTab === tab ? 'var(--color-accent-500, #3b82f6)' : 'var(--bolt-elements-textSecondary)',
              borderBottom: activeTab === tab ? '2px solid var(--color-accent-500, #3b82f6)' : '2px solid transparent',
            }}
          >
            <div className={`${TAB_ICONS[tab]} w-3 h-3`} aria-hidden="true" />
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div
        className="overflow-y-auto flex-1 min-h-0 bg-bolt-elements-background-depth-2"
        role="tabpanel"
        id={`inspector-tabpanel-${activeTab}`}
        aria-labelledby={`inspector-tab-${activeTab}`}
      >
        {activeTab === 'styles' && (
          <StylesTabContent
            selectedElement={selectedElement}
            pendingEdits={pendingEdits}
            pendingTextEdit={pendingTextEdit}
            onStyleChange={handleStyleChange}
            onTextContentChange={handleTextChange}
            onImageSrcChange={handleImageSrcChange}
            onImageAltChange={handleImageAltChange}
            onBackgroundImageChange={handleBackgroundImageChange}
            copyFeedback={copyFeedback}
            onCopyAllStyles={handleCopyAllStyles}
          />
        )}

        {activeTab === 'box' && (
          <BoxTabContent
            selectedElement={selectedElement}
            onNavigate={inspector.selectFromTree}
            onBoxModelChange={handleStyleChange}
          />
        )}

        {activeTab === 'theme' && (
          <ThemeEditor
            themeData={inspector.themeData}
            onScanTheme={inspector.scanTheme}
            onEditCSSVar={inspector.editCSSVar}
            onStyleChange={handleStyleChange}
          />
        )}

        {activeTab === 'ai' && <AiTabContent selectedElement={selectedElement} onQuickAction={handleAIAction} />}
      </div>

      {/* Footer with action buttons */}
      <div className="p-3 border-t border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 space-y-2">
        {/* Bulk CSS section */}
        {accumulatedBulkChanges.length > 0 && (
          <div className="space-y-2 p-2 rounded-lg border border-green-500/30 bg-green-500/5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-green-400 font-medium">
                {accumulatedBulkChanges.length} bulk {accumulatedBulkChanges.length === 1 ? 'change' : 'changes'}{' '}
                pending
              </span>
              <button
                onClick={inspector.clearBulkChanges}
                className="text-bolt-elements-textTertiary hover:text-red-400 transition-colors"
                title="Clear all bulk changes"
                aria-label="Clear all bulk changes"
              >
                <div className="i-ph:x-circle w-4 h-4" />
              </button>
            </div>
            <button
              onClick={inspector.applyBulkCSS}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors"
            >
              <div className="i-ph:code w-3.5 h-3.5" aria-hidden="true" />
              Apply All Bulk CSS
            </button>
          </div>
        )}

        {hasChanges ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <button
                onClick={handleCopyCSS}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-4 transition-colors"
              >
                <div className="i-ph:clipboard w-3.5 h-3.5" aria-hidden="true" />
                {copyFeedback || 'Copy CSS'}
              </button>
              <button
                onClick={inspector.applyWithAI}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-accent-500 text-white hover:bg-accent-600 transition-colors"
              >
                <div className="i-ph:magic-wand w-3.5 h-3.5" aria-hidden="true" />
                Apply with AI
              </button>
            </div>

            {/* Revert */}
            <button
              onClick={handleRevert}
              className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                bulkTarget
                  ? 'border-purple-500/30 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 hover:border-purple-500/50'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/50'
              }`}
            >
              <div className="i-ph:arrow-counter-clockwise w-3.5 h-3.5" aria-hidden="true" />
              {bulkTarget ? `Revert All ${bulkTarget.label}` : 'Revert Changes'}
            </button>
          </div>
        ) : (
          <p className="text-bolt-elements-textTertiary text-xs text-center">Edit values above to see live changes</p>
        )}

        {/* Delete element */}
        <button
          onClick={handleDeleteElement}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:border-red-500/50 transition-colors"
        >
          <div className="i-ph:chat-circle-dots w-3.5 h-3.5" aria-hidden="true" />
          Ask AI to Remove
        </button>
      </div>
    </div>
  );
});

InspectorPanel.displayName = 'InspectorPanel';
