import { getFineTunedPrompt } from './prompts/new-prompt';
import { getCompactPrompt } from './prompts/compact-prompt';
import type { DesignScheme } from '~/types/design-scheme';

export interface PromptOptions {
  cwd: string;
  allowedHtmlElements: string[];
  modificationTagName: string;
  designScheme?: DesignScheme;
  supabase?: {
    isConnected: boolean;
    hasSelectedProject: boolean;
    credentials?: {
      anonKey?: string;
      supabaseUrl?: string;
    };
  };

  /** Whether the Flutter SDK is installed on the host machine. */
  flutterAvailable?: boolean;
}

export class PromptLibrary {
  static library: Record<
    string,
    {
      label: string;
      description: string;
      get: (options: PromptOptions) => string;
    }
  > = {
    default: {
      label: 'Default Prompt',
      description: 'A fine tuned prompt for better results and less token usage',
      get: (options) =>
        getFineTunedPrompt(options.cwd, options.supabase, options.designScheme, options.flutterAvailable),
    },
    compact: {
      label: 'Compact Prompt (small models)',
      description:
        'A minimal prompt (~1/8 the size of the default) for small-context or small-parameter models. Auto-selected for models with very small context windows.',
      get: (options) => getCompactPrompt(options.cwd, options.supabase, options.designScheme, options.flutterAvailable),
    },
  };
  static getList() {
    return Object.entries(this.library).map(([key, value]) => {
      const { label, description } = value;
      return {
        id: key,
        label,
        description,
      };
    });
  }
  static getPromptFromLibrary(promptId: string, options: PromptOptions) {
    const prompt = this.library[promptId];

    if (!prompt) {
      throw new Error(`Prompt not found: ${promptId}`);
    }

    return this.library[promptId]?.get(options);
  }
}
