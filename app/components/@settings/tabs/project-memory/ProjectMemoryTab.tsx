import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '@nanostores/react';
import { runtime } from '~/lib/runtime';
import { cn } from '~/utils/cn';
import { toast } from 'sonner';
import { createScopedLogger } from '~/utils/logger';
import { useFileContent } from '~/lib/hooks/useFileContent';
import { workbenchStore } from '~/lib/stores/workbench';
import { memoryStore, addMemoryEntry, removeMemoryEntry } from '~/lib/stores/agentMemory';
import { useMemorySync } from '~/lib/hooks/useMemorySync';
import {
  KNOWLEDGE_ALLOWED_EXTENSIONS,
  KNOWLEDGE_DIR_ABSOLUTE,
  KNOWLEDGE_DIR_RELATIVE,
  KNOWLEDGE_MAX_FILE_SIZE,
  collectKnowledgeDocuments,
  sanitizeKnowledgeFileName,
} from '~/lib/common/knowledge';

const logger = createScopedLogger('ProjectMemory');

const PROJECT_MEMORY_PATH = '/home/project/PROJECT.md';
const RELATIVE_PATH = 'PROJECT.md';

const DEFAULT_TEMPLATE = `# Project Memory

This file contains persistent instructions for the AI. The AI will read this file at the start of every conversation and follow these rules.

## Project Information
- Project Name:
- Description:

## Coding Standards
-

## Style Guidelines
-

## Important Notes
-
`;

/**
 * Format a timestamp into a human-readable relative time string.
 * No external libraries needed — uses simple math.
 */
function formatRelativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();

  if (isNaN(then)) {
    return 'unknown';
  }

  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) {
    return 'just now';
  }

  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }

  if (diffHr < 24) {
    return `${diffHr}h ago`;
  }

  return `${diffDay}d ago`;
}

/** Sections shown in the tab switcher */
type MemorySection = 'project' | 'knowledge' | 'agent';

/** Format a byte-ish character count for display. */
function formatSize(chars: number): string {
  if (chars < 1024) {
    return `${chars} B`;
  }

  return `${(chars / 1024).toFixed(1)} KB`;
}

export default function ProjectMemoryTab() {
  const fileContent = useFileContent(PROJECT_MEMORY_PATH);
  const files = useStore(workbenchStore.files);
  const memoryState = useStore(memoryStore);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Section toggle between PROJECT.md editor and agent memory viewer
  const [activeSection, setActiveSection] = useState<MemorySection>('project');

  // Add-form UI state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  // Delete-confirmation UI state
  const [deleteTarget, setDeleteTarget] = useState<{ category: string; key: string } | null>(null);

  // Knowledge base UI state
  const [isUploading, setIsUploading] = useState(false);
  const [deleteDocTarget, setDeleteDocTarget] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Ensure MEMORY.md stays in sync with the store
  useMemorySync();

  useEffect(() => {
    if (typeof fileContent === 'string') {
      setContent(fileContent);
      setOriginalContent(fileContent);
    } else {
      setContent('');
      setOriginalContent('');
    }
  }, [fileContent]);

  // Track unsaved changes
  useEffect(() => {
    setHasUnsavedChanges(content !== originalContent);
  }, [content, originalContent]);

  const handleSave = useCallback(async () => {
    if (!content.trim()) {
      toast.warning('Cannot save empty content. Add some instructions first.');
      return;
    }

    setIsSaving(true);

    try {
      /* Write directly to runtime filesystem */
      const rt = await runtime;
      await rt.fs.writeFile(RELATIVE_PATH, content);

      // Update the files store to reflect the change
      workbenchStore.files.setKey(PROJECT_MEMORY_PATH, {
        type: 'file',
        content,
        isBinary: false,
      });

      setOriginalContent(content);
      setHasUnsavedChanges(false);
      toast.success('Project memory saved successfully!');
    } catch (error) {
      logger.error('Failed to save PROJECT.md:', error);
      toast.error('Failed to save project memory. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [content]);

  const handleCreateTemplate = useCallback(() => {
    setContent(DEFAULT_TEMPLATE);
  }, []);

  const handleReset = useCallback(() => {
    setContent(originalContent);
    setHasUnsavedChanges(false);
  }, [originalContent]);

  /* ---- Knowledge base helpers ---- */

  const knowledgeDocuments = useMemo(() => collectKnowledgeDocuments(files), [files]);

  const handleUploadDocuments = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) {
      return;
    }

    setIsUploading(true);

    let uploaded = 0;

    try {
      const rt = await runtime;

      for (const file of Array.from(fileList)) {
        const name = sanitizeKnowledgeFileName(file.name);

        if (!name) {
          toast.warning(
            `"${file.name}" skipped — only ${KNOWLEDGE_ALLOWED_EXTENSIONS.join(', ')} files are supported.`,
          );
          continue;
        }

        if (file.size > KNOWLEDGE_MAX_FILE_SIZE) {
          toast.warning(`"${file.name}" skipped — larger than ${Math.round(KNOWLEDGE_MAX_FILE_SIZE / 1024)} KB.`);
          continue;
        }

        const text = await file.text();

        if (!text.trim()) {
          toast.warning(`"${file.name}" skipped — file is empty.`);
          continue;
        }

        await rt.fs.writeFile(`${KNOWLEDGE_DIR_RELATIVE}/${name}`, text);

        // Mirror into the files store so injection works without waiting on the watcher
        workbenchStore.files.setKey(`${KNOWLEDGE_DIR_ABSOLUTE}/${name}`, {
          type: 'file',
          content: text,
          isBinary: false,
        });

        uploaded += 1;
      }

      if (uploaded > 0) {
        toast.success(`Added ${uploaded} document${uploaded === 1 ? '' : 's'} to the knowledge base.`);
      }
    } catch (error) {
      logger.error('Failed to upload knowledge documents:', error);
      toast.error('Failed to upload documents. Please try again.');
    } finally {
      setIsUploading(false);

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, []);

  const handleDeleteDocument = useCallback(async (name: string) => {
    try {
      const rt = await runtime;
      await rt.fs.rm(`${KNOWLEDGE_DIR_RELATIVE}/${name}`);
      workbenchStore.files.setKey(`${KNOWLEDGE_DIR_ABSOLUTE}/${name}`, undefined);
      toast.success(`Removed "${name}" from the knowledge base.`);
    } catch (error) {
      logger.error(`Failed to delete knowledge document: ${name}`, error);
      toast.error(`Failed to remove "${name}". Please try again.`);
    } finally {
      setDeleteDocTarget(null);
    }
  }, []);

  /* ---- Agent Memory helpers ---- */

  const handleAddEntry = useCallback(() => {
    const trimmedCategory = newCategory.trim();
    const trimmedKey = newKey.trim();
    const trimmedValue = newValue.trim();

    if (!trimmedCategory) {
      toast.warning('Category is required.');
      return;
    }

    if (!trimmedKey) {
      toast.warning('Key is required.');
      return;
    }

    if (!trimmedValue) {
      toast.warning('Value is required.');
      return;
    }

    addMemoryEntry(trimmedCategory, trimmedKey, trimmedValue);
    toast.success(`Memory entry "${trimmedKey}" added to "${trimmedCategory}".`);

    // Reset form
    setNewCategory('');
    setNewKey('');
    setNewValue('');
    setShowAddForm(false);
  }, [newCategory, newKey, newValue]);

  const handleDeleteEntry = useCallback((category: string, key: string) => {
    const removed = removeMemoryEntry(category, key);

    if (removed) {
      toast.success(`Memory entry "${key}" removed.`);
    } else {
      toast.error(`Failed to remove entry "${key}".`);
    }

    setDeleteTarget(null);
  }, []);

  /** Sorted category names for stable rendering */
  const sortedCategories = useMemo(() => Object.keys(memoryState).sort(), [memoryState]);

  /** Total entry count across all categories */
  const totalEntries = useMemo(
    () => Object.values(memoryState).reduce((sum, entries) => sum + entries.length, 0),
    [memoryState],
  );

  const fileExists = !!files[PROJECT_MEMORY_PATH];

  return (
    <div className="flex flex-col h-full">
      <motion.div
        className="flex flex-col gap-6 p-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        {/* Section Switcher */}
        <div className="flex items-center gap-1 p-1 rounded-lg bg-bolt-elements-background-depth-2 w-fit">
          <button
            onClick={() => setActiveSection('project')}
            className={cn(
              'px-3 py-1.5 text-xs rounded-md font-medium transition-colors duration-200',
              activeSection === 'project'
                ? 'bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text'
                : 'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary',
            )}
          >
            <span className="flex items-center gap-1.5">
              <div className="i-ph:file-text w-3.5 h-3.5" />
              PROJECT.md
            </span>
          </button>
          <button
            onClick={() => setActiveSection('knowledge')}
            className={cn(
              'px-3 py-1.5 text-xs rounded-md font-medium transition-colors duration-200',
              activeSection === 'knowledge'
                ? 'bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text'
                : 'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary',
            )}
          >
            <span className="flex items-center gap-1.5">
              <div className="i-ph:books w-3.5 h-3.5" />
              Knowledge
              {knowledgeDocuments.length > 0 && (
                <span className="ml-1 px-1.5 py-0 text-[10px] rounded-full bg-bolt-elements-item-contentAccent/15 text-bolt-elements-item-contentAccent font-semibold">
                  {knowledgeDocuments.length}
                </span>
              )}
            </span>
          </button>
          <button
            onClick={() => setActiveSection('agent')}
            className={cn(
              'px-3 py-1.5 text-xs rounded-md font-medium transition-colors duration-200',
              activeSection === 'agent'
                ? 'bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text'
                : 'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary',
            )}
          >
            <span className="flex items-center gap-1.5">
              <div className="i-ph:brain w-3.5 h-3.5" />
              Agent Memory
              {totalEntries > 0 && (
                <span className="ml-1 px-1.5 py-0 text-[10px] rounded-full bg-bolt-elements-item-contentAccent/15 text-bolt-elements-item-contentAccent font-semibold">
                  {totalEntries}
                </span>
              )}
            </span>
          </button>
        </div>

        {/* ============ PROJECT.md Section ============ */}
        {activeSection === 'project' && (
          <>
            {/* Header Section */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-medium text-bolt-elements-textPrimary">Project Memory</h3>
                  {fileExists ? (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/10 text-green-500 font-medium">
                      Active
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-gray-500/10 text-gray-500 font-medium">
                      Not Created
                    </span>
                  )}
                </div>
                {hasUnsavedChanges && <span className="text-xs text-orange-500 font-medium">Unsaved changes</span>}
              </div>
              <p className="text-sm text-bolt-elements-textSecondary">
                Create a PROJECT.md file to give the AI persistent instructions that apply to every conversation in this
                project. The AI will read this file automatically and follow your rules.
              </p>
            </div>

            {/* Info Card */}
            <div
              className={cn(
                'p-4 rounded-lg',
                'bg-bolt-elements-background-depth-2',
                'border border-bolt-elements-borderColor',
              )}
            >
              <h4 className="text-sm font-medium text-bolt-elements-textPrimary mb-2 flex items-center gap-2">
                <div className="i-ph:lightbulb w-4 h-4 text-bolt-elements-item-contentAccent" />
                What can you put in Project Memory?
              </h4>
              <ul className="text-sm text-bolt-elements-textSecondary space-y-1 list-disc list-inside">
                <li>Coding standards and conventions (e.g., "Use TypeScript strict mode")</li>
                <li>Style guidelines (e.g., "All headings must be red")</li>
                <li>Project-specific rules (e.g., "Never modify the config.ts file")</li>
                <li>Architecture decisions (e.g., "Use functional components with hooks")</li>
                <li>File structure preferences</li>
              </ul>
            </div>

            {/* Editor Section */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-bolt-elements-textPrimary">PROJECT.md Content</label>
                {!content && !fileExists && (
                  <button
                    onClick={handleCreateTemplate}
                    className={cn(
                      'px-3 py-1.5 text-xs rounded-md',
                      'bg-bolt-elements-button-primary-background',
                      'text-bolt-elements-button-primary-text',
                      'hover:bg-bolt-elements-button-primary-backgroundHover',
                      'transition-colors duration-200',
                    )}
                  >
                    Start with Template
                  </button>
                )}
              </div>

              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                aria-label="Project instructions"
                placeholder="Enter your project instructions here... The AI will follow these rules in every conversation."
                className={cn(
                  'w-full h-64 p-3 rounded-lg resize-y',
                  'bg-bolt-elements-background-depth-3',
                  'border border-bolt-elements-borderColor',
                  'text-bolt-elements-textPrimary',
                  'placeholder-bolt-elements-textTertiary',
                  'focus:outline-none focus:ring-2 focus:ring-bolt-elements-focus',
                  'font-mono text-sm',
                  'transition-colors duration-200',
                )}
              />

              {/* Action Buttons */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSave}
                  disabled={isSaving || !hasUnsavedChanges}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium',
                    'bg-bolt-elements-button-primary-background',
                    'text-bolt-elements-button-primary-text',
                    'hover:bg-bolt-elements-button-primary-backgroundHover',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'transition-all duration-200',
                  )}
                >
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </button>

                {hasUnsavedChanges && (
                  <button
                    onClick={handleReset}
                    className={cn(
                      'px-4 py-2 rounded-lg text-sm font-medium',
                      'bg-bolt-elements-background-depth-2',
                      'text-bolt-elements-textSecondary',
                      'hover:text-bolt-elements-textPrimary',
                      'border border-bolt-elements-borderColor',
                      'transition-all duration-200',
                    )}
                  >
                    Discard Changes
                  </button>
                )}
              </div>
            </div>

            {/* File Path Info */}
            <div className="text-xs text-bolt-elements-textTertiary">
              File location:{' '}
              <code className="px-1 py-0.5 rounded bg-bolt-elements-background-depth-2">{PROJECT_MEMORY_PATH}</code>
            </div>
          </>
        )}

        {/* ============ Knowledge Base Section ============ */}
        {activeSection === 'knowledge' && (
          <>
            {/* Header */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-medium text-bolt-elements-textPrimary">Knowledge Base</h3>
                  {knowledgeDocuments.length > 0 ? (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/10 text-green-500 font-medium">
                      {knowledgeDocuments.length} {knowledgeDocuments.length === 1 ? 'document' : 'documents'}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-gray-500/10 text-gray-500 font-medium">
                      Empty
                    </span>
                  )}
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  className={cn(
                    'px-3 py-1.5 text-xs rounded-md font-medium',
                    'bg-bolt-elements-button-primary-background',
                    'text-bolt-elements-button-primary-text',
                    'hover:bg-bolt-elements-button-primary-backgroundHover',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'transition-colors duration-200',
                    'flex items-center gap-1.5',
                  )}
                >
                  <div className="i-ph:upload-simple w-3.5 h-3.5" />
                  {isUploading ? 'Uploading...' : 'Upload Documents'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={KNOWLEDGE_ALLOWED_EXTENSIONS.join(',')}
                  className="hidden"
                  aria-label="Upload knowledge documents"
                  onChange={(e) => void handleUploadDocuments(e.target.files)}
                />
              </div>
              <p className="text-sm text-bolt-elements-textSecondary">
                Upload reference documents — coding style guides, API docs, specs — and the AI will consult them in
                every conversation for this project. Supported formats: {KNOWLEDGE_ALLOWED_EXTENSIONS.join(', ')} (max{' '}
                {Math.round(KNOWLEDGE_MAX_FILE_SIZE / 1024)} KB each).
              </p>
            </div>

            {/* Document list */}
            {knowledgeDocuments.length === 0 ? (
              <div
                className={cn(
                  'p-8 rounded-lg text-center',
                  'bg-bolt-elements-background-depth-2',
                  'border border-dashed border-bolt-elements-borderColor',
                )}
              >
                <div className="i-ph:books w-8 h-8 mx-auto mb-2 text-bolt-elements-textTertiary" />
                <p className="text-sm text-bolt-elements-textSecondary">
                  No documents yet. Upload style guides or reference material to give the AI project-specific knowledge.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {knowledgeDocuments.map((doc) => (
                  <div
                    key={doc.path}
                    className={cn(
                      'flex items-center justify-between gap-3 px-3 py-2 rounded-lg',
                      'bg-bolt-elements-background-depth-2',
                      'border border-bolt-elements-borderColor',
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="i-ph:file-text w-4 h-4 shrink-0 text-bolt-elements-item-contentAccent" />
                      <span className="text-sm text-bolt-elements-textPrimary truncate">{doc.name}</span>
                      <span className="text-xs text-bolt-elements-textTertiary shrink-0">
                        {formatSize(doc.content.length)}
                      </span>
                    </div>
                    {deleteDocTarget === doc.name ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => void handleDeleteDocument(doc.name)}
                          className="px-2 py-1 text-xs rounded-md font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors duration-200"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setDeleteDocTarget(null)}
                          className="px-2 py-1 text-xs rounded-md font-medium text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors duration-200"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteDocTarget(doc.name)}
                        aria-label={`Remove ${doc.name}`}
                        className="p-1.5 rounded-md text-bolt-elements-textTertiary hover:text-red-500 hover:bg-red-500/10 transition-colors duration-200 shrink-0"
                      >
                        <div className="i-ph:trash w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Storage path info */}
            <div className="text-xs text-bolt-elements-textTertiary">
              Documents are stored in{' '}
              <code className="px-1 py-0.5 rounded bg-bolt-elements-background-depth-2">{KNOWLEDGE_DIR_ABSOLUTE}</code>{' '}
              and travel with the project.
            </div>
          </>
        )}

        {/* ============ Agent Memory Section ============ */}
        {activeSection === 'agent' && (
          <>
            {/* Header */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-medium text-bolt-elements-textPrimary">Agent Memory</h3>
                  {totalEntries > 0 ? (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/10 text-green-500 font-medium">
                      {totalEntries} {totalEntries === 1 ? 'entry' : 'entries'}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-gray-500/10 text-gray-500 font-medium">
                      Empty
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setShowAddForm((prev) => !prev)}
                  className={cn(
                    'px-3 py-1.5 text-xs rounded-md font-medium',
                    'bg-bolt-elements-button-primary-background',
                    'text-bolt-elements-button-primary-text',
                    'hover:bg-bolt-elements-button-primary-backgroundHover',
                    'transition-colors duration-200',
                    'flex items-center gap-1.5',
                  )}
                >
                  <div className={showAddForm ? 'i-ph:x w-3.5 h-3.5' : 'i-ph:plus w-3.5 h-3.5'} />
                  {showAddForm ? 'Cancel' : 'Add Entry'}
                </button>
              </div>
              <p className="text-sm text-bolt-elements-textSecondary">
                Cross-session memory entries are created by the agent during conversations. They persist across sessions
                via MEMORY.md and help the agent remember preferences, decisions, and patterns.
              </p>
            </div>

            {/* Usage Summary */}
            {totalEntries > 0 && (
              <div
                className={cn(
                  'p-4 rounded-lg',
                  'bg-bolt-elements-background-depth-2',
                  'border border-bolt-elements-borderColor',
                )}
              >
                <h4 className="text-sm font-medium text-bolt-elements-textPrimary mb-3 flex items-center gap-2">
                  <div className="i-ph:chart-bar w-4 h-4 text-bolt-elements-item-contentAccent" />
                  Memory Usage
                </h4>
                <div className="flex flex-wrap gap-3">
                  {sortedCategories.map((category) => {
                    const count = memoryState[category]?.length ?? 0;

                    return (
                      <div
                        key={category}
                        className={cn(
                          'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs',
                          'bg-bolt-elements-background-depth-3',
                          'border border-bolt-elements-borderColor',
                        )}
                      >
                        <span className="font-medium text-bolt-elements-textPrimary">{category}</span>
                        <span className="text-bolt-elements-textTertiary">
                          {count}/{20}
                        </span>
                      </div>
                    );
                  })}
                  <div
                    className={cn(
                      'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs',
                      'bg-bolt-elements-item-contentAccent/10',
                      'border border-bolt-elements-item-contentAccent/20',
                    )}
                  >
                    <span className="font-medium text-bolt-elements-item-contentAccent">Total</span>
                    <span className="text-bolt-elements-item-contentAccent">{totalEntries}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Add Entry Form */}
            {showAddForm && (
              <motion.div
                className={cn(
                  'p-4 rounded-lg',
                  'bg-bolt-elements-background-depth-2',
                  'border border-bolt-elements-borderColor',
                )}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                transition={{ duration: 0.2 }}
              >
                <h4 className="text-sm font-medium text-bolt-elements-textPrimary mb-3 flex items-center gap-2">
                  <div className="i-ph:plus-circle w-4 h-4 text-bolt-elements-item-contentAccent" />
                  New Memory Entry
                </h4>
                <div className="flex flex-col gap-3">
                  <div className="flex gap-3">
                    <div className="flex flex-col gap-1 flex-1">
                      <label className="text-xs text-bolt-elements-textSecondary">Category</label>
                      <input
                        type="text"
                        value={newCategory}
                        onChange={(e) => setNewCategory(e.target.value)}
                        placeholder="e.g., preferences, decisions, patterns"
                        className={cn(
                          'w-full px-3 py-2 rounded-md text-sm',
                          'bg-bolt-elements-background-depth-3',
                          'border border-bolt-elements-borderColor',
                          'text-bolt-elements-textPrimary',
                          'placeholder-bolt-elements-textTertiary',
                          'focus:outline-none focus:ring-2 focus:ring-bolt-elements-focus',
                          'transition-colors duration-200',
                        )}
                      />
                    </div>
                    <div className="flex flex-col gap-1 flex-1">
                      <label className="text-xs text-bolt-elements-textSecondary">Key</label>
                      <input
                        type="text"
                        value={newKey}
                        onChange={(e) => setNewKey(e.target.value)}
                        placeholder="e.g., preferred-framework"
                        className={cn(
                          'w-full px-3 py-2 rounded-md text-sm',
                          'bg-bolt-elements-background-depth-3',
                          'border border-bolt-elements-borderColor',
                          'text-bolt-elements-textPrimary',
                          'placeholder-bolt-elements-textTertiary',
                          'focus:outline-none focus:ring-2 focus:ring-bolt-elements-focus',
                          'transition-colors duration-200',
                        )}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-bolt-elements-textSecondary">Value</label>
                    <textarea
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      placeholder="Describe the memory entry..."
                      rows={3}
                      className={cn(
                        'w-full px-3 py-2 rounded-md text-sm resize-y',
                        'bg-bolt-elements-background-depth-3',
                        'border border-bolt-elements-borderColor',
                        'text-bolt-elements-textPrimary',
                        'placeholder-bolt-elements-textTertiary',
                        'focus:outline-none focus:ring-2 focus:ring-bolt-elements-focus',
                        'transition-colors duration-200',
                      )}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleAddEntry}
                      className={cn(
                        'px-4 py-2 rounded-lg text-sm font-medium',
                        'bg-bolt-elements-button-primary-background',
                        'text-bolt-elements-button-primary-text',
                        'hover:bg-bolt-elements-button-primary-backgroundHover',
                        'transition-all duration-200',
                      )}
                    >
                      Add Entry
                    </button>
                    <button
                      onClick={() => {
                        setShowAddForm(false);
                        setNewCategory('');
                        setNewKey('');
                        setNewValue('');
                      }}
                      className={cn(
                        'px-4 py-2 rounded-lg text-sm font-medium',
                        'bg-bolt-elements-background-depth-2',
                        'text-bolt-elements-textSecondary',
                        'hover:text-bolt-elements-textPrimary',
                        'border border-bolt-elements-borderColor',
                        'transition-all duration-200',
                      )}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Memory Entries — grouped by category */}
            {totalEntries > 0 ? (
              <div className="flex flex-col gap-4">
                {sortedCategories.map((category) => {
                  const entries = memoryState[category];

                  if (!entries || entries.length === 0) {
                    return null;
                  }

                  return (
                    <div key={category} className="flex flex-col gap-2">
                      <h4 className="text-sm font-medium text-bolt-elements-textPrimary flex items-center gap-2">
                        <div className="i-ph:folder-open w-4 h-4 text-bolt-elements-item-contentAccent" />
                        {category}
                        <span className="text-xs text-bolt-elements-textTertiary font-normal">({entries.length})</span>
                      </h4>
                      <div className="flex flex-col gap-1.5">
                        {entries.map((entry) => (
                          <div
                            key={`${category}-${entry.key}`}
                            className={cn(
                              'flex items-start justify-between gap-3 p-3 rounded-lg',
                              'bg-bolt-elements-background-depth-2',
                              'border border-bolt-elements-borderColor',
                              'group',
                            )}
                          >
                            <div className="flex flex-col gap-1 min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-bolt-elements-textPrimary">{entry.key}</span>
                                <span className="text-[10px] text-bolt-elements-textTertiary whitespace-nowrap">
                                  {formatRelativeTime(entry.updatedAt)}
                                </span>
                              </div>
                              <p className="text-xs text-bolt-elements-textSecondary break-words line-clamp-2">
                                {entry.summary}
                              </p>
                            </div>
                            <div className="flex-shrink-0 pt-0.5">
                              {deleteTarget?.category === category && deleteTarget?.key === entry.key ? (
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[10px] text-bolt-elements-textTertiary whitespace-nowrap">
                                    Are you sure?
                                  </span>
                                  <button
                                    onClick={() => handleDeleteEntry(category, entry.key)}
                                    className={cn(
                                      'px-2 py-1 text-[10px] rounded font-medium',
                                      'bg-red-500/15 text-red-500',
                                      'hover:bg-red-500/25',
                                      'transition-colors duration-200',
                                    )}
                                  >
                                    Delete
                                  </button>
                                  <button
                                    onClick={() => setDeleteTarget(null)}
                                    className={cn(
                                      'px-2 py-1 text-[10px] rounded font-medium',
                                      'text-bolt-elements-textTertiary',
                                      'hover:text-bolt-elements-textPrimary',
                                      'transition-colors duration-200',
                                    )}
                                  >
                                    No
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setDeleteTarget({ category, key: entry.key })}
                                  className={cn(
                                    'p-1 rounded opacity-0 group-hover:opacity-100',
                                    'text-bolt-elements-textTertiary',
                                    'hover:text-red-500 hover:bg-red-500/10',
                                    'transition-all duration-200',
                                  )}
                                  title={`Delete "${entry.key}"`}
                                >
                                  <div className="i-ph:trash w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                className={cn(
                  'flex flex-col items-center justify-center gap-3 p-8 rounded-lg',
                  'bg-bolt-elements-background-depth-2',
                  'border border-bolt-elements-borderColor border-dashed',
                )}
              >
                <div className="i-ph:brain w-10 h-10 text-bolt-elements-textTertiary" />
                <div className="text-center">
                  <p className="text-sm font-medium text-bolt-elements-textPrimary mb-1">
                    No cross-session memories yet
                  </p>
                  <p className="text-xs text-bolt-elements-textTertiary max-w-sm">
                    The agent builds memory during conversations — preferences, decisions, and patterns it discovers.
                    These persist across sessions via MEMORY.md so the agent remembers context between chats.
                  </p>
                </div>
                <button
                  onClick={() => setShowAddForm(true)}
                  className={cn(
                    'mt-2 px-3 py-1.5 text-xs rounded-md font-medium',
                    'bg-bolt-elements-button-primary-background',
                    'text-bolt-elements-button-primary-text',
                    'hover:bg-bolt-elements-button-primary-backgroundHover',
                    'transition-colors duration-200',
                    'flex items-center gap-1.5',
                  )}
                >
                  <div className="i-ph:plus w-3.5 h-3.5" />
                  Add Entry Manually
                </button>
              </div>
            )}

            {/* File Path Info for Agent Memory */}
            <div className="text-xs text-bolt-elements-textTertiary">
              Synced to:{' '}
              <code className="px-1 py-0.5 rounded bg-bolt-elements-background-depth-2">/home/project/MEMORY.md</code>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
