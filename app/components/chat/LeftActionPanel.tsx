import { lazy, Suspense } from 'react';
import type { Message } from 'ai';
import { toast } from 'sonner';
import { ImportFolderButton } from '~/components/chat/ImportFolderButton';
import { Button } from '~/components/ui/Button';
import { cn } from '~/utils/cn';
import type { ImportChatFn } from '~/lib/persistence/db';

const GitCloneButton = lazy(() => import('./GitCloneButton'));

type ChatData = {
  messages?: Message[];
  description?: string;
};

interface LeftActionPanelProps {
  importChat?: ImportChatFn;
}

export function LeftActionPanel({ importChat }: LeftActionPanelProps) {
  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];

    if (file && importChat) {
      try {
        const reader = new FileReader();

        reader.onload = async (event) => {
          try {
            const content = event.target?.result as string;
            const data = JSON.parse(content) as ChatData;

            if (Array.isArray(data.messages)) {
              await importChat(data.description || 'Imported Chat', data.messages);
              toast.success('Chat imported successfully');

              return;
            }

            toast.error('Invalid chat file format');
          } catch (error: unknown) {
            if (error instanceof Error) {
              toast.error('Failed to parse chat file: ' + error.message);
            } else {
              toast.error('Failed to parse chat file');
            }
          }
        };

        reader.onerror = () => toast.error('Failed to read chat file');
        reader.readAsText(file);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to import chat');
      }

      e.target.value = '';
    } else {
      toast.error('Something went wrong');
    }
  };

  /*
   * Prompt-first home: import/clone are secondary actions rendered as a quiet
   * ghost-button row below the prompt box, not chunky cards above it.
   */
  const compactButtonClass = cn(
    '!flex items-center gap-1.5 justify-center',
    'h-8 px-3 py-0 rounded-lg text-xs font-medium',
    'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary',
    'border border-transparent hover:border-bolt-elements-borderColor',
    'bg-transparent hover:bg-bolt-elements-bg-depth-3',
    'transition-all duration-200 ease-in-out',
    'shadow-none',
  );

  return (
    <div className="flex flex-wrap items-center justify-center gap-1">
      <span className="text-xs text-bolt-elements-textTertiary mr-1">or start from</span>

      {/* Hidden file input */}
      <input
        type="file"
        id="chat-import-left"
        className="hidden"
        accept=".json"
        onChange={handleFileImport}
        aria-label="Import chat file"
      />

      {/* Import Chat Button */}
      <Button
        onClick={() => {
          const input = document.getElementById('chat-import-left');
          input?.click();
        }}
        variant="ghost"
        className={compactButtonClass}
      >
        <span className="i-ph:upload-simple w-3.5 h-3.5" />
        <span>Import Chat</span>
      </Button>

      {/* Import Folder Button */}
      <ImportFolderButton
        importChat={importChat}
        className={compactButtonClass}
        style={{ backgroundColor: 'transparent' }}
      />

      {/* Clone a Repo Button */}
      <Suspense>
        <GitCloneButton
          importChat={importChat}
          className={compactButtonClass}
          style={{ backgroundColor: 'transparent' }}
        />
      </Suspense>
    </div>
  );
}
