/**
 * Source-context enrichment for the Element Inspector's AI actions.
 *
 * When the inspector knows which source file (and line) produced a clicked
 * element, we read that file through the runtime filesystem and embed a
 * small annotated snippet into the outgoing AI prompt. This lets the model
 * jump straight to the right JSX instead of grepping for a selector.
 *
 * All functions fail soft: any error results in the original prompt being
 * sent without source context.
 *
 * @module lib/inspector/source-context
 */

import { runtime } from '~/lib/runtime';
import { WORK_DIR } from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('InspectorSourceContext');

/** Number of lines shown before and after the target line. */
const SNIPPET_CONTEXT_LINES = 8;

/** Maximum snippet size when no line number is available. */
const SNIPPET_HEAD_LINES = 40;

/** The minimal element shape needed for enrichment. */
export interface SourceLocatable {
  sourceFile?: string;
  sourceLine?: number;
}

/**
 * Normalise an inspector-reported source path to a project-relative path
 * usable with the runtime filesystem API.
 *
 * Handles absolute host paths (`/home/user/.devonz/projects/<id>/src/App.tsx`),
 * virtual workdir paths (`/home/project/src/App.tsx`), and plain relative
 * paths with or without a leading slash.
 */
export function normalizeSourcePath(sourceFile: string): string {
  const projectsMatch = sourceFile.match(/[/\\]projects[/\\][^/\\]+[/\\](.+)$/);

  if (projectsMatch) {
    return projectsMatch[1].replaceAll('\\', '/');
  }

  if (sourceFile.startsWith(`${WORK_DIR}/`)) {
    return sourceFile.slice(WORK_DIR.length + 1);
  }

  return sourceFile.replace(/^\/+/, '').replaceAll('\\', '/');
}

/**
 * Build a markdown block describing the element's source location, with a
 * line-annotated snippet of the surrounding code when the file is readable.
 * Returns an empty string when no source information is available.
 */
export async function buildSourceContext(element: SourceLocatable): Promise<string> {
  if (!element.sourceFile) {
    return '';
  }

  const relativePath = normalizeSourcePath(element.sourceFile);
  const location = `${relativePath}${element.sourceLine != null ? `:${element.sourceLine}` : ''}`;
  const locationBlock = `\n\n**Source location:** \`${location}\``;

  try {
    const rt = await runtime;
    const content = await rt.fs.readFile(relativePath);

    if (!content) {
      return locationBlock;
    }

    const lines = content.split('\n');

    let start = 0;
    let end = Math.min(lines.length, SNIPPET_HEAD_LINES);

    if (element.sourceLine != null && element.sourceLine >= 1) {
      start = Math.max(0, element.sourceLine - 1 - SNIPPET_CONTEXT_LINES);
      end = Math.min(lines.length, element.sourceLine + SNIPPET_CONTEXT_LINES);
    }

    const snippet = lines
      .slice(start, end)
      .map((line, index) => {
        const lineNumber = start + index + 1;
        const marker = element.sourceLine != null && lineNumber === element.sourceLine ? '>' : ' ';

        return `${marker} ${String(lineNumber).padStart(4)} | ${line}`;
      })
      .join('\n');

    return `${locationBlock}\n\n\`\`\`\n${snippet}\n\`\`\``;
  } catch (error) {
    logger.warn('Failed to read source file for element context', { sourceFile: element.sourceFile, error });
    return locationBlock;
  }
}

/**
 * Append source context to an AI prompt when the element carries source
 * information. Always resolves; falls back to the original message.
 */
export async function enrichWithSourceContext(message: string, element: SourceLocatable | null): Promise<string> {
  if (!element?.sourceFile) {
    return message;
  }

  try {
    const context = await buildSourceContext(element);
    return context ? `${message}${context}` : message;
  } catch {
    return message;
  }
}
