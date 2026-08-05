/**
 * Shared Shiki syntax highlighter singleton.
 *
 * Consolidates the three independent `createHighlighter` / `codeToHtml` call
 * sites (CodeBlock, Artifact, ToolInvocations) into one lazily-initialised
 * instance so that Shiki's 200 KB+ language bundle is loaded exactly once.
 */
import {
  createHighlighter,
  bundledLanguages,
  isSpecialLang,
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
  type SpecialLanguage,
} from 'shiki';

/* ------------------------------------------------------------------ */
/*  Merged language set used across all consumers                     */
/* ------------------------------------------------------------------ */

/**
 * Languages loaded eagerly when the highlighter is created.
 * Keep this list SMALL (~10) to avoid Vite dependency optimisation
 * thrashing — additional languages are loaded on demand inside
 * `safeCodeToHtml()` via `highlighter.loadLanguage()`.
 */
const PRELOADED_LANGS: BundledLanguage[] = [
  'shell',
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'css',
  'html',
  'json',
  'markdown',
  'python',
];

const THEMES: BundledTheme[] = ['light-plus', 'dark-plus'];

/* ------------------------------------------------------------------ */
/*  Singleton with HMR preservation                                   */
/* ------------------------------------------------------------------ */

/** Preserve the highlighter instance across Vite HMR refreshes. */
let _highlighter: HighlighterGeneric<BundledLanguage, BundledTheme> | undefined =
  ((import.meta.hot?.data as Record<string, unknown> | undefined)?.sharedHighlighter as
    HighlighterGeneric<BundledLanguage, BundledTheme> | undefined) ?? undefined;

let _initPromise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | undefined;

/**
 * Returns the shared Shiki highlighter, creating it on first call.
 * Subsequent calls return the cached instance.
 */
export async function getSharedHighlighter(): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  if (_highlighter) {
    return _highlighter;
  }

  if (!_initPromise) {
    _initPromise = createHighlighter({
      langs: PRELOADED_LANGS,
      themes: THEMES,
    }).then((h) => {
      _highlighter = h;

      if (import.meta.hot) {
        (import.meta.hot.data as Record<string, unknown>).sharedHighlighter = h;
      }

      return h;
    });
  }

  return _initPromise;
}

/* ------------------------------------------------------------------ */
/*  Safe highlighting with dynamic language loading fallback          */
/* ------------------------------------------------------------------ */

/**
 * Highlight code with automatic language loading and plaintext fallback.
 * If the requested language isn't loaded, attempts to load it dynamically.
 * Falls back to plaintext on any error to prevent unhandled rejections.
 */
export async function safeCodeToHtml(code: string, lang: string, theme: BundledTheme = 'dark-plus'): Promise<string> {
  const highlighter = await getSharedHighlighter();

  let effectiveLang: BundledLanguage | SpecialLanguage = isSpecialLang(lang as SpecialLanguage)
    ? (lang as SpecialLanguage)
    : lang in bundledLanguages
      ? (lang as BundledLanguage)
      : 'plaintext';

  if (!isSpecialLang(effectiveLang as string) && effectiveLang !== 'plaintext') {
    const loaded = highlighter.getLoadedLanguages();

    if (!loaded.includes(effectiveLang as string)) {
      try {
        await highlighter.loadLanguage(effectiveLang as BundledLanguage);
      } catch {
        effectiveLang = 'plaintext';
      }
    }
  }

  try {
    return highlighter.codeToHtml(code, { lang: effectiveLang, theme });
  } catch {
    return highlighter.codeToHtml(code, { lang: 'plaintext', theme });
  }
}

/* ------------------------------------------------------------------ */
/*  Re-exports used by CodeBlock (keeps its API unchanged)            */
/* ------------------------------------------------------------------ */

export { bundledLanguages, isSpecialLang };
export type { BundledLanguage, BundledTheme, HighlighterGeneric, SpecialLanguage };
