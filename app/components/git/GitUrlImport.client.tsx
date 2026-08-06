import { useSearchParams } from 'react-router';
import { generateId, type Message } from 'ai';
import { useEffect, useState } from 'react';
import { Chat } from '~/components/chat/Chat.client';
import { useChatHistory } from '~/lib/persistence';
import { createCommandsMessage, detectProjectCommands, escapeBoltTags } from '~/utils/projectCommands';
import { cleanPackageJson } from '~/utils/packageJsonCleaner';
import { LoadingOverlay } from '~/components/ui/LoadingOverlay';
import { toast } from 'sonner';
import { createScopedLogger } from '~/utils/logger';
import { csrfFetch } from '~/lib/api/csrf-client';

const logger = createScopedLogger('GitUrlImport');

export function GitUrlImport() {
  const [searchParams] = useSearchParams();
  const { ready: historyReady, importChat } = useChatHistory();
  const [imported, setImported] = useState(false);
  const [loading, setLoading] = useState(true);

  const importRepo = async (repoUrl: string) => {
    if (!historyReady || !importChat) {
      return;
    }

    let baseUrl = repoUrl;
    let branch: string | undefined;

    if (repoUrl.includes('#')) {
      [baseUrl, branch] = repoUrl.split('#');
    }

    try {
      /*
       * ── Step 1: Server-side git clone ──
       * Uses native `git clone --depth 1` on the server, which is
       * orders of magnitude faster than isomorphic-git in the browser.
       */
      const cloneResponse = await csrfFetch('/api/git-clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: baseUrl, branch }),
      });

      if (!cloneResponse.ok) {
        const err = (await cloneResponse.json()) as { message?: string };
        throw new Error(err.message || 'Server-side clone failed');
      }

      const cloneEnvelope = (await cloneResponse.json()) as {
        data: {
          tempId: string;
          files: Array<{ path: string; content: string }>;
        };
      };
      const { tempId, files } = cloneEnvelope.data;

      /*
       * ── Step 2: Clean package.json ──
       */
      const fileContents = [...files];
      const packageJsonIndex = fileContents.findIndex((f) => f.path === 'package.json');

      if (packageJsonIndex !== -1) {
        const allPaths = fileContents.map((f) => f.path);
        const cleanResult = cleanPackageJson(fileContents[packageJsonIndex].content, allPaths);

        if (cleanResult.cleaned) {
          fileContents[packageJsonIndex] = {
            ...fileContents[packageJsonIndex],
            content: cleanResult.content,
          };
          logger.info('Cleaned package.json:', cleanResult.removedDeps);
        }
      }

      /*
       * ── Step 3: Detect project commands ──
       */
      const commands = await detectProjectCommands(fileContents);
      const commandsMessage = createCommandsMessage(commands);

      /*
       * ── Step 4: Build chat messages ──
       * File actions are marked preloaded="true" so the action runner
       * knows the files are already on disk and can skip re-writing.
       */
      const filesMessage: Message = {
        role: 'assistant',
        content: `Cloning the repo ${repoUrl} into /home/project
<boltArtifact id="imported-files" title="Git Cloned Files" type="bundled" preloaded="true">
${fileContents
  .map(
    (file) =>
      `<boltAction type="file" filePath="${file.path}">
${escapeBoltTags(file.content)}
</boltAction>`,
  )
  .join('\n')}
</boltArtifact>`,
        id: generateId(),
        createdAt: new Date(),
      };

      const messages: Message[] = [filesMessage];

      if (commandsMessage) {
        messages.push({
          role: 'user',
          id: generateId(),
          content: 'Setup the codebase and Start the application',
        });
        messages.push(commandsMessage);
      }

      /*
       * ── Step 5: Create the chat (without redirect) ──
       * We skip the redirect so we can finalize the clone first.
       */
      const chatId = await importChat(
        `Git Project:${baseUrl.split('/').slice(-1)[0]}`,
        messages,
        { gitUrl: repoUrl },
        { skipRedirect: true },
      );

      /*
       * ── Step 6: Move cloned files to the project directory ──
       * The server renames _clone_{tempId} → projects/{chatId}.
       * Files are already on disk when the chat loads.
       */
      if (chatId) {
        try {
          await csrfFetch('/api/git-clone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'finalize', tempId, projectId: chatId }),
          });
        } catch (err) {
          logger.warn('Finalize failed, files will be recreated by action runner:', err);
        }

        /* Now redirect to the new chat. */
        window.location.href = `/chat/${chatId}`;
      }
    } catch (error) {
      logger.error('Error during import:', error);
      toast.error('Failed to import repository');
      setLoading(false);
      window.location.href = '/';
    }
  };

  useEffect(() => {
    if (!historyReady || imported) {
      return;
    }

    const url = searchParams.get('url');

    if (!url) {
      window.location.href = '/';
      return;
    }

    importRepo(url).catch((error) => {
      logger.error('Error importing repo:', error);
      toast.error('Failed to import repository');
      setLoading(false);
      window.location.href = '/';
    });
    setImported(true);
  }, [searchParams, historyReady, imported]);

  return (
    <>
      <Chat />
      {loading && <LoadingOverlay message="Please wait while we clone the repository..." />}
    </>
  );
}
