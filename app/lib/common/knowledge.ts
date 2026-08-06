/**
 * Knowledge base — user-uploaded reference documents (style guides, specs,
 * API docs) that are injected into the system prompt on every LLM call.
 *
 * Documents live inside the project at `.bolt/knowledge/` so they persist
 * with the project, sync through the normal runtime file watcher into the
 * client `FileMap`, and reach the server with every chat request.
 *
 * This module is shared between client (upload UI) and server (prompt
 * injection), so it must stay free of client-store and server-only imports.
 */

export const KNOWLEDGE_DIR_RELATIVE = '.bolt/knowledge';
export const KNOWLEDGE_DIR_ABSOLUTE = '/home/project/.bolt/knowledge';

/** Extensions accepted by the upload UI (plain-text reference material). */
export const KNOWLEDGE_ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

/** Maximum size of a single uploaded document (bytes). */
export const KNOWLEDGE_MAX_FILE_SIZE = 200 * 1024;

/** Total character budget for knowledge injected into the system prompt. */
export const KNOWLEDGE_INJECTION_CHAR_BUDGET = 24_000;

/** Minimum leftover budget worth spending on another (truncated) document. */
const MIN_USEFUL_SLICE = 500;

/**
 * Minimal structural view of the client `FileMap` so this shared module does
 * not import client stores or server-only constants.
 */
export type KnowledgeFileMap = Record<string, { type: string; content?: string; isBinary?: boolean } | undefined>;

export function isKnowledgeFilePath(absolutePath: string): boolean {
  return absolutePath.startsWith(`${KNOWLEDGE_DIR_ABSOLUTE}/`);
}

export function hasAllowedKnowledgeExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return KNOWLEDGE_ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Normalize an uploaded file name to a safe basename: strips any path
 * segments and collapses characters outside a conservative allowlist.
 * Returns `undefined` when nothing usable remains.
 */
export function sanitizeKnowledgeFileName(rawName: string): string | undefined {
  const base = rawName.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^a-zA-Z0-9._ -]+/g, '-')
    .replace(/^[.\s-]+/, '')
    .trim();

  if (!cleaned || !hasAllowedKnowledgeExtension(cleaned)) {
    return undefined;
  }

  return cleaned;
}

export interface KnowledgeDocument {
  /** Absolute path inside the project (e.g. `/home/project/.bolt/knowledge/style.md`). */
  path: string;

  /** File name shown to the user and the LLM. */
  name: string;
  content: string;
}

/** Collect non-empty text documents under the knowledge dir, sorted by name. */
export function collectKnowledgeDocuments(files: KnowledgeFileMap | undefined): KnowledgeDocument[] {
  if (!files) {
    return [];
  }

  return Object.entries(files)
    .filter(
      ([path, dirent]) =>
        isKnowledgeFilePath(path) &&
        dirent?.type === 'file' &&
        !dirent.isBinary &&
        typeof dirent.content === 'string' &&
        dirent.content.trim().length > 0,
    )
    .map(([path, dirent]) => ({
      path,
      name: path.slice(KNOWLEDGE_DIR_ABSOLUTE.length + 1),
      content: (dirent as { content: string }).content,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render the `<knowledge_base>` system-prompt section for the given files,
 * keeping the total injected content within {@link KNOWLEDGE_INJECTION_CHAR_BUDGET}.
 * Returns `undefined` when there is nothing to inject.
 */
export function buildKnowledgeBaseSection(files: KnowledgeFileMap | undefined): string | undefined {
  const documents = collectKnowledgeDocuments(files);

  if (documents.length === 0) {
    return undefined;
  }

  let remaining = KNOWLEDGE_INJECTION_CHAR_BUDGET;
  const rendered: string[] = [];
  let omitted = 0;

  for (const doc of documents) {
    if (remaining < MIN_USEFUL_SLICE) {
      omitted += 1;
      continue;
    }

    let content = doc.content.trim();

    if (content.length > remaining) {
      content = `${content.slice(0, remaining)}\n[... truncated — document exceeds the knowledge budget]`;
    }

    remaining -= Math.min(doc.content.trim().length, remaining);
    rendered.push(`<document name="${doc.name}">\n${content}\n</document>`);
  }

  const omittedNote = omitted > 0 ? `\n\n[${omitted} additional document(s) omitted — knowledge budget exhausted]` : '';

  return `<knowledge_base>
The user uploaded the following reference documents (coding style guides, specs, API docs) for this project. Consult them whenever relevant, and treat any coding style or convention rules they define as mandatory for this project.

${rendered.join('\n\n')}${omittedNote}
</knowledge_base>`;
}
