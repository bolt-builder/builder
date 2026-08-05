/**
 * Decides which editor renders a given file when Monaco is the preferred editor.
 *
 * This module must stay free of `monaco-editor` imports: it is consumed eagerly
 * by the workbench (EditorPanel) while Monaco itself is lazy-loaded.
 */

/**
 * Extensions that stay on CodeMirror because Monaco ships no built-in grammar
 * for them while our CodeMirror setup has a dedicated language package
 * (see app/components/editor/codemirror/languages.ts).
 */
const CODEMIRROR_ONLY_EXTENSIONS = new Set(['vue', 'wat']);

/** `.env`, `.env.local`, `config/.env.production`, ... */
export function isEnvFile(filePath: string): boolean {
  const fileName = filePath.split('/').pop() ?? '';
  return fileName === '.env' || fileName.startsWith('.env.');
}

/**
 * True when the file should be rendered by CodeMirror even though Monaco is
 * the preferred editor: env files keep CodeMirror's secret-value masking, and
 * a handful of languages only have CodeMirror grammars.
 */
export function shouldUseCodeMirrorForFile(filePath: string): boolean {
  if (isEnvFile(filePath)) {
    return true;
  }

  const fileName = filePath.split('/').pop() ?? '';
  const dotIndex = fileName.lastIndexOf('.');

  if (dotIndex <= 0) {
    // No extension (Makefile, Dockerfile, LICENSE, ...) — Monaco handles these fine.
    return false;
  }

  const extension = fileName.slice(dotIndex + 1).toLowerCase();

  return CODEMIRROR_ONLY_EXTENSIONS.has(extension);
}
