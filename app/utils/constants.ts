import { LLMManager } from '~/lib/modules/llm/manager';
import type { Template } from '~/types/template';

export const WORK_DIR_NAME = 'project';
export const WORK_DIR = `/home/${WORK_DIR_NAME}`;
export const MODIFICATIONS_TAG_NAME = 'bolt_file_modifications';
export const MODEL_REGEX = /^\[Model: (.*?)\]\n\n/;
export const PROVIDER_REGEX = /\[Provider: (.*?)\]\n\n/;
export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
export const PROMPT_COOKIE_KEY = 'cachedPrompt';
export const TOOL_EXECUTION_APPROVAL = {
  APPROVE: 'Yes, approved.',
  REJECT: 'No, rejected.',
} as const;
export const TOOL_NO_EXECUTE_FUNCTION = 'Error: No execute function found on tool';
export const TOOL_EXECUTION_DENIED = 'Error: User denied access to tool execution';
export const TOOL_EXECUTION_ERROR = 'Error: An error occurred while calling tool';

const llmManager = LLMManager.getInstance(import.meta.env);

export const PROVIDER_LIST = llmManager.getAllProviders();
export const DEFAULT_PROVIDER = llmManager.getDefaultProvider();

export const providerBaseUrlEnvKeys: Record<string, { baseUrlKey?: string; apiTokenKey?: string }> = {};
PROVIDER_LIST.forEach((provider) => {
  providerBaseUrlEnvKeys[provider.name] = {
    baseUrlKey: provider.config.baseUrlKey,
    apiTokenKey: provider.config.apiTokenKey,
  };
});

// starter Templates

export const STARTER_TEMPLATES: Template[] = [
  {
    name: 'Expo App',
    label: 'Expo App',
    description: 'Expo starter template for building cross-platform mobile apps',
    githubRepo: 'xKevIsDev/bolt-expo-template',
    tags: ['mobile', 'expo', 'mobile-app', 'android', 'iphone'],
    icon: 'i-bolt:expo',
  },
  {
    name: 'Basic Astro',
    label: 'Astro Basic',
    description: 'Lightweight Astro starter template for building fast static websites',
    githubRepo: 'xKevIsDev/bolt-astro-basic-template',
    tags: ['astro', 'blog', 'performance', 'static', 'docs', 'documentation', 'landing-page', 'content'],
    icon: 'i-bolt:astro',
  },
  {
    name: 'NextJS Shadcn',
    label: 'Next.js with shadcn/ui',
    description: 'Next.js starter fullstack template with SSR, API routes, and shadcn/ui components',
    githubRepo: 'xKevIsDev/bolt-nextjs-shadcn-template',
    tags: ['nextjs', 'react', 'typescript', 'shadcn', 'tailwind', 'fullstack', 'ssr', 'api-routes'],
    icon: 'i-bolt:nextjs',
  },
  {
    name: 'Vite Shadcn',
    label: 'Vite with shadcn/ui',
    description: 'Vite starter template with shadcn/ui components — the default for most web projects',
    githubRepo: 'xKevIsDev/vite-shadcn',
    tags: [
      'vite',
      'react',
      'typescript',
      'shadcn',
      'tailwind',
      'spa',
      'dashboard',
      'saas',
      'admin',
      'crud',
      'form',
      'ui',
    ],
    icon: 'i-bolt:shadcn',
  },
  {
    name: 'Qwik Typescript',
    label: 'Qwik TypeScript',
    description: 'Qwik framework starter with TypeScript for building resumable applications',
    githubRepo: 'xKevIsDev/bolt-qwik-ts-template',
    tags: ['qwik', 'typescript', 'performance', 'resumable'],
    icon: 'i-bolt:qwik',
  },
  {
    name: 'Remix Typescript',
    label: 'Remix TypeScript',
    description: 'Remix framework starter with TypeScript for full-stack web applications',
    githubRepo: 'xKevIsDev/bolt-remix-ts-template',
    tags: ['remix', 'typescript', 'fullstack', 'react'],
    icon: 'i-bolt:remix',
  },
  {
    name: 'Slidev',
    label: 'Slidev Presentation',
    description: 'Slidev starter template for creating presentations, slide decks, and pitch decks using Markdown',
    githubRepo: 'xKevIsDev/bolt-slidev-template',
    tags: [
      'slidev',
      'presentation',
      'markdown',
      'slides',
      'slide',
      'deck',
      'pitch',
      'sales',
      'keynote',
      'slideshow',
      'talk',
    ],
    icon: 'i-bolt:slidev',
  },
  {
    name: 'Sveltekit',
    label: 'SvelteKit',
    description: 'SvelteKit starter template for building fast, efficient web applications',
    githubRepo: 'xKevIsDev/bolt-sveltekit-template',
    tags: ['svelte', 'sveltekit', 'typescript'],
    icon: 'i-bolt:svelte',
  },
  {
    name: 'Vanilla Vite',
    label: 'Vanilla + Vite',
    description: 'Minimal Vite starter template for vanilla JavaScript projects',
    githubRepo: 'xKevIsDev/vanilla-vite-template',
    tags: ['vite', 'vanilla-js', 'minimal', 'javascript', 'simple', 'plain'],
    icon: 'i-bolt:vite',
  },
  {
    name: 'Vite React',
    label: 'React + Vite + Tailwind',
    description: 'React starter template powered by Vite with Tailwind CSS v4 for fast development',
    githubRepo: 'xKevIsDev/bolt-vite-react-ts-template',
    tags: ['react', 'vite', 'tailwind', 'frontend', 'website', 'app', 'game', 'canvas', 'animation'],
    icon: 'i-bolt:react',
  },
  {
    name: 'Vite Typescript',
    label: 'Vite + TypeScript',
    description: 'Vite starter template with TypeScript configuration for type-safe development',
    githubRepo: 'xKevIsDev/bolt-vite-ts-template',
    tags: ['vite', 'typescript', 'minimal'],
    icon: 'i-bolt:typescript',
  },
  {
    name: 'Vue',
    label: 'Vue.js',
    description: 'Vue.js starter template with modern tooling and best practices',
    githubRepo: 'xKevIsDev/bolt-vue-template',
    tags: ['vue', 'typescript', 'frontend'],
    icon: 'i-bolt:vue',
  },
  {
    name: 'Angular',
    label: 'Angular Starter',
    description: 'A modern Angular starter template with TypeScript support and best practices configuration',
    githubRepo: 'xKevIsDev/bolt-angular-template',
    tags: ['angular', 'typescript', 'frontend', 'spa'],
    icon: 'i-bolt:angular',
  },
  {
    name: 'SolidJS',
    label: 'SolidJS Tailwind',
    description: 'Lightweight SolidJS starter template for building fast static websites',
    githubRepo: 'xKevIsDev/solidjs-ts-tw',
    tags: ['solidjs', 'solid', 'reactive', 'tailwind', 'typescript'],
    icon: 'i-bolt:solidjs',
  },
];
