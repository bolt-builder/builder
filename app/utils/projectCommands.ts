import type { Message } from 'ai';
import { generateId } from './fileUtils';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ProjectCommands');

export interface ProjectCommands {
  type: string;
  setupCommand?: string;
  startCommand?: string;
  followupMessage: string;
}

interface FileContent {
  content: string;
  path: string;
}

/**
 * Make a command non-interactive for runtime execution.
 *
 * NOTE: We intentionally do NOT add env var exports or extra npm flags here.
 * The runtime's `.npmrc` (injected at boot) already has:
 *   legacy-peer-deps=true, yes=true, fund=false, audit=false, loglevel=error
 *
 * Adding `export CI=true ...` prefix prevents the action runner's
 * --legacy-peer-deps injection regex from matching
 * (it expects commands to start with `npm install`).
 */
function makeNonInteractive(command: string): string {
  const interactivePackages = [
    { pattern: /npx\s+([^@\s]+@?[^\s]*)\s+init/g, replacement: 'npx --yes $1 init --defaults' },
    { pattern: /npx\s+create-([^\s]+)/g, replacement: 'npx --yes create-$1' },
    { pattern: /npx\s+([^@\s]+@?[^\s]*)\s+add/g, replacement: 'npx --yes $1 add --defaults' },
  ];

  let processedCommand = command;

  interactivePackages.forEach(({ pattern, replacement }) => {
    processedCommand = processedCommand.replace(pattern, replacement);
  });

  return processedCommand;
}

export async function detectProjectCommands(files: FileContent[]): Promise<ProjectCommands> {
  const hasFile = (name: string) => files.some((f) => f.path.endsWith(name));
  const hasFileContent = (name: string, content: string) =>
    files.some((f) => f.path.endsWith(name) && f.content.includes(content));

  if (hasFile('package.json')) {
    const packageJsonFile = files.find((f) => f.path.endsWith('package.json'));

    if (!packageJsonFile) {
      return { type: '', setupCommand: '', followupMessage: '' };
    }

    try {
      const packageJson = JSON.parse(packageJsonFile.content);
      const scripts = packageJson?.scripts || {};
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

      // Check if this is a shadcn project
      const isShadcnProject =
        hasFileContent('components.json', 'shadcn') ||
        Object.keys(dependencies).some((dep) => dep.includes('shadcn')) ||
        hasFile('components.json');

      // Check for preferred commands in priority order
      const preferredCommands = ['dev', 'start', 'preview'];
      const availableCommand = preferredCommands.find((cmd) => scripts[cmd]);

      // Build setup command with non-interactive handling
      let baseSetupCommand = 'npm install';

      /*
       * Only run shadcn init if this is a NEW shadcn project (no existing ui components).
       * For imported/cloned templates, components are already present so init is skipped.
       */
      const hasExistingComponents = files.some((f) => f.path.includes('components/ui/') && f.path.endsWith('.tsx'));

      if (isShadcnProject && !hasExistingComponents) {
        baseSetupCommand += ' && npx shadcn@latest init';
      }

      const setupCommand = makeNonInteractive(baseSetupCommand);

      if (availableCommand) {
        /*
         * Use the script content to build a more reliable start command.
         * Some shells may fail to find binaries from npm scripts
         * (e.g., "command not found: next") because node_modules/.bin
         * isn't always on PATH. Using npx ensures the binary is always found.
         */
        const scriptContent = scripts[availableCommand] || '';
        let startCommand = `npm run ${availableCommand}`;

        // For known framework binaries, use npx for reliable resolution
        const frameworkBinaries: Record<string, string> = {
          next: 'npx next',
          vite: 'npx vite',
          nuxt: 'npx nuxt',
          remix: 'npx remix',
          astro: 'npx astro',
        };

        for (const [binary, npxCommand] of Object.entries(frameworkBinaries)) {
          if (scriptContent.startsWith(`${binary} `)) {
            // Replace the binary with npx variant, keep the rest of the args
            const args = scriptContent.slice(binary.length);
            startCommand = `${npxCommand}${args}`;
            break;
          }

          if (scriptContent === binary) {
            startCommand = npxCommand;
            break;
          }
        }

        return {
          type: 'Node.js',
          setupCommand,
          startCommand,
          followupMessage: `Found "${availableCommand}" script in package.json. Running "${startCommand}" after installation.`,
        };
      }

      return {
        type: 'Node.js',
        setupCommand,
        followupMessage:
          'Would you like me to inspect package.json to determine the available scripts for running this project?',
      };
    } catch (error) {
      logger.error('Error parsing package.json:', error);
      return { type: '', setupCommand: '', followupMessage: '' };
    }
  }

  if (hasFile('index.html')) {
    return {
      type: 'Static',
      startCommand: 'npx --yes serve',
      followupMessage: '',
    };
  }

  return { type: '', setupCommand: '', followupMessage: '' };
}

export function createCommandsMessage(commands: ProjectCommands): Message | null {
  if (!commands.setupCommand && !commands.startCommand) {
    return null;
  }

  let commandString = '';

  if (commands.setupCommand) {
    commandString += `
<boltAction type="shell">${commands.setupCommand}</boltAction>`;
  }

  if (commands.startCommand) {
    commandString += `
<boltAction type="start">${commands.startCommand}</boltAction>
`;
  }

  return {
    role: 'assistant',
    content: `
${commands.followupMessage ? `\n\n${commands.followupMessage}` : ''}
<boltArtifact id="project-setup" title="Project Setup">
${commandString}
</boltArtifact>`,
    id: generateId(),
    createdAt: new Date(),
  };
}

export function escapeBoltArtifactTags(input: string) {
  // Regular expression to match boltArtifact tags and their content
  const regex = /(<boltArtifact[^>]*>)([\s\S]*?)(<\/boltArtifact>)/g;

  return input.replace(regex, (_match, openTag, content, closeTag) => {
    // Escape the opening tag
    const escapedOpenTag = openTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Escape the closing tag
    const escapedCloseTag = closeTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Return the escaped version
    return `${escapedOpenTag}${content}${escapedCloseTag}`;
  });
}

export function escapeBoltAActionTags(input: string) {
  // Regular expression to match boltArtifact tags and their content
  const regex = /(<boltAction[^>]*>)([\s\S]*?)(<\/boltAction>)/g;

  return input.replace(regex, (_match, openTag, content, closeTag) => {
    // Escape the opening tag
    const escapedOpenTag = openTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Escape the closing tag
    const escapedCloseTag = closeTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Return the escaped version
    return `${escapedOpenTag}${content}${escapedCloseTag}`;
  });
}

export function escapeBoltTags(input: string) {
  return escapeBoltArtifactTags(escapeBoltAActionTags(input));
}

// We have this seperate function to simplify the restore snapshot process in to one single artifact.
export function createCommandActionsString(commands: ProjectCommands): string {
  if (!commands.setupCommand && !commands.startCommand) {
    // Return empty string if no commands
    return '';
  }

  let commandString = '';

  if (commands.setupCommand) {
    commandString += `
<boltAction type="shell">${commands.setupCommand}</boltAction>`;
  }

  if (commands.startCommand) {
    commandString += `
<boltAction type="start">${commands.startCommand}</boltAction>
`;
  }

  return commandString;
}
