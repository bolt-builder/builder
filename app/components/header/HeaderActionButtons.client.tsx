import { lazy, Suspense, useState } from 'react';
import { useStore } from '@nanostores/react';
import { workbenchStore } from '~/lib/stores/workbench';
import { vercelConnection } from '~/lib/stores/vercel';
import { DeployButton } from '~/components/deploy/DeployButton';

const VercelDomainModal = lazy(() =>
  import('~/components/deploy/VercelDomainModal').then((m) => ({ default: m.VercelDomainModal })),
);
import { HeaderAvatar } from './HeaderAvatar.client';
import { AutoFixStatus } from './AutoFixStatus.client';
import { chatId } from '~/lib/persistence/useChatHistory';

export function HeaderActionButtons() {
  const [activePreviewIndex] = useState(0);
  const [isVercelModalOpen, setIsVercelModalOpen] = useState(false);
  const previews = useStore(workbenchStore.previews);
  const currentView = useStore(workbenchStore.currentView);
  const connection = useStore(vercelConnection);
  const currentChatId = useStore(chatId);
  const activePreview = previews[activePreviewIndex];

  // Check if this project has been deployed to Vercel
  const hasVercelDeployment =
    currentChatId && typeof localStorage !== 'undefined'
      ? localStorage.getItem(`vercel-project-${currentChatId}`) !== null
      : false;

  const shouldShowButtons = activePreview;
  const showVercelButton = shouldShowButtons && connection.user && hasVercelDeployment;

  const handleVersionsClick = () => {
    // Toggle between versions and code view
    if (currentView === 'versions') {
      workbenchStore.currentView.set('code');
    } else {
      workbenchStore.currentView.set('versions');
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Auto-Fix Status Indicator */}
      <AutoFixStatus />

      {/* Versions Button */}
      {shouldShowButtons && (
        <button
          onClick={handleVersionsClick}
          className={`rounded-md items-center justify-center px-3 py-1.5 text-xs bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary border border-bolt-elements-borderColor hover:bg-bolt-elements-background-depth-4 hover:text-accent-400 outline-accent-500 flex gap-1.5 transition-colors ${
            currentView === 'versions' ? 'text-accent-400 border-accent-500/50' : ''
          }`}
        >
          <div className="i-ph:clock-counter-clockwise" />
          Versions
        </button>
      )}

      {/* Vercel Domain Settings Button */}
      {showVercelButton && (
        <button
          onClick={() => setIsVercelModalOpen(true)}
          className="rounded-md items-center justify-center px-2 py-1.5 text-xs bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary border border-bolt-elements-borderColor hover:bg-bolt-elements-background-depth-4 hover:text-bolt-elements-textPrimary hover:border-accent-500/50 outline-accent-500 flex gap-1 transition-colors"
          title="Vercel Domain Settings"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 76 65" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
          </svg>
        </button>
      )}

      {/* Deploy Button */}
      {shouldShowButtons && <DeployButton />}

      {/* Avatar */}
      <HeaderAvatar />

      {/* Vercel Domain Modal */}
      {isVercelModalOpen && (
        <Suspense>
          <VercelDomainModal isOpen={isVercelModalOpen} onClose={() => setIsVercelModalOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
