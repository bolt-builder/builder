import { useStore } from '@nanostores/react';
import { vercelConnection } from '~/lib/stores/vercel';
import { chatId } from '~/lib/persistence/useChatHistory';
import { vercelApi } from '~/lib/api/vercel-client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useState } from 'react';
import { createScopedLogger } from '~/utils/logger';
import type { VercelProject, VercelDeployment } from '~/types/vercel';

const logger = createScopedLogger('VercelDeployLink');

export function VercelDeploymentLink() {
  const connection = useStore(vercelConnection);
  const currentChatId = useStore(chatId);
  const [deploymentUrl, setDeploymentUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    async function fetchProjectData() {
      if (!connection.token || !currentChatId) {
        return;
      }

      // Check if we have a stored project ID for this chat
      const projectId = localStorage.getItem(`vercel-project-${currentChatId}`);

      if (!projectId) {
        return;
      }

      setIsLoading(true);

      try {
        // Fetch projects via proxy (bypasses CORS)
        const projectsResult = await vercelApi.get<{ projects: VercelProject[] }>('/v9/projects', connection.token);

        if (!projectsResult.success || !projectsResult.data) {
          throw new Error(projectsResult.error || 'Failed to fetch projects');
        }

        const projects = projectsResult.data.projects || [];

        // Extract the chat number from currentChatId
        const chatNumber = currentChatId.split('-')[0];

        // Find project by matching the chat number in the name
        const project = projects.find((p: { name: string | string[] }) => p.name.includes(`bolt-diy-${chatNumber}`));

        if (project) {
          // Fetch project details via proxy
          const projectDetailsResult = await vercelApi.get<VercelProject>(
            `/v9/projects/${project.id}`,
            connection.token,
          );

          if (projectDetailsResult.success && projectDetailsResult.data) {
            const projectDetails = projectDetailsResult.data;

            // Try to get URL from production aliases first
            if (projectDetails.targets?.production?.alias && projectDetails.targets.production.alias.length > 0) {
              // Find the clean URL (without -projects.vercel.app)
              const cleanUrl = projectDetails.targets.production.alias.find(
                (a: string) => a.endsWith('.vercel.app') && !a.includes('-projects.vercel.app'),
              );

              if (cleanUrl) {
                setDeploymentUrl(`https://${cleanUrl}`);
                return;
              } else {
                // If no clean URL found, use the first alias
                setDeploymentUrl(`https://${projectDetails.targets.production.alias[0]}`);
                return;
              }
            }
          }

          // If no aliases or project details failed, try fetching deployments
          const deploymentsResult = await vercelApi.get<{ deployments: VercelDeployment[] }>(
            `/v6/deployments?projectId=${project.id}&limit=1`,
            connection.token,
          );

          if (deploymentsResult.success && deploymentsResult.data) {
            const deploymentsData = deploymentsResult.data;

            if (deploymentsData.deployments && deploymentsData.deployments.length > 0) {
              setDeploymentUrl(`https://${deploymentsData.deployments[0].url}`);
              return;
            }
          }
        }

        // Fallback to API call if not found in fetched projects
        const fallbackResponse = await fetch(`/api/vercel-deploy?projectId=${projectId}&token=${connection.token}`, {
          method: 'GET',
        });

        const envelope = (await fallbackResponse.json()) as {
          success: boolean;
          data?: { deploy?: { url?: string }; project?: { url?: string } };
        };
        const fallbackData = envelope.data;

        if (fallbackData?.deploy?.url) {
          setDeploymentUrl(fallbackData.deploy.url);
        } else if (fallbackData?.project?.url) {
          setDeploymentUrl(fallbackData.project.url);
        }
      } catch (err) {
        logger.error('Error fetching Vercel deployment:', err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchProjectData();
  }, [connection.token, currentChatId]);

  if (!deploymentUrl) {
    return null;
  }

  return (
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <a
            href={deploymentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center w-8 h-8 rounded hover:bg-bolt-elements-item-backgroundActive text-bolt-elements-textSecondary hover:text-[#000000] z-50"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <div className={`i-ph:link w-4 h-4 hover:text-blue-400 ${isLoading ? 'animate-pulse' : ''}`} />
          </a>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="px-3 py-2 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary text-xs z-50"
            sideOffset={5}
          >
            {deploymentUrl}
            <Tooltip.Arrow className="fill-bolt-elements-background-depth-3" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
