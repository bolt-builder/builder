import { atom } from 'nanostores';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('PromptTemplates');

export interface PromptTemplate {
  id: string;
  label: string;
  text: string;
  builtIn?: boolean;
}

const STORAGE_KEY = 'bolt_prompt_templates';

/**
 * Curated starter templates. Users can add their own on top; built-ins are
 * not editable or deletable so the list always has useful defaults.
 */
export const BUILT_IN_TEMPLATES: PromptTemplate[] = [
  {
    id: 'tpl-responsive',
    label: 'Make it responsive',
    text: 'Make the entire app fully responsive. Audit every page at mobile (375px), tablet (768px), and desktop (1280px) widths and fix layout, spacing, and font-size issues. Use fluid layouts instead of fixed widths.',
    builtIn: true,
  },
  {
    id: 'tpl-dark-mode',
    label: 'Add dark mode',
    text: 'Add a dark mode with a toggle in the header. Respect the system preference by default, persist the user choice, and make sure every component has proper dark variants with sufficient contrast.',
    builtIn: true,
  },
  {
    id: 'tpl-polish-ui',
    label: 'Polish the design',
    text: 'Improve the visual design without changing functionality: consistent spacing scale, better typography hierarchy, subtle hover/focus states, rounded corners and shadows where appropriate, and a cohesive color palette.',
    builtIn: true,
  },
  {
    id: 'tpl-fix-errors',
    label: 'Fix all errors',
    text: 'Run the app, check the terminal and browser console for errors and warnings, and fix all of them. Explain each root cause briefly after fixing.',
    builtIn: true,
  },
  {
    id: 'tpl-add-tests',
    label: 'Add tests',
    text: 'Add tests for the core functionality of this app. Cover the main user flows and edge cases. Set up the test runner if one is not configured yet, and make sure all tests pass.',
    builtIn: true,
  },
  {
    id: 'tpl-a11y',
    label: 'Improve accessibility',
    text: 'Audit the app for accessibility issues: missing alt text, unlabeled form controls, poor color contrast, missing keyboard navigation, and incorrect heading structure. Fix everything you find.',
    builtIn: true,
  },
  {
    id: 'tpl-seo',
    label: 'Add SEO basics',
    text: 'Add SEO essentials: descriptive title and meta description per page, Open Graph and Twitter card tags, semantic HTML landmarks, and a sitemap if the framework supports it.',
    builtIn: true,
  },
];

function loadUserTemplates(): PromptTemplate[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (t): t is PromptTemplate =>
        typeof t?.id === 'string' && typeof t?.label === 'string' && typeof t?.text === 'string',
    );
  } catch (error) {
    logger.warn('Failed to load user prompt templates', error);

    return [];
  }
}

export const userTemplatesStore = atom<PromptTemplate[]>(loadUserTemplates());

function persist(templates: PromptTemplate[]) {
  userTemplatesStore.set(templates);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch (error) {
    logger.warn('Failed to persist user prompt templates', error);
  }
}

export function addUserTemplate(label: string, text: string): PromptTemplate {
  const template: PromptTemplate = {
    id: `tpl-user-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    label: label.trim(),
    text,
  };

  persist([...userTemplatesStore.get(), template]);

  return template;
}

export function removeUserTemplate(id: string) {
  persist(userTemplatesStore.get().filter((t) => t.id !== id));
}
