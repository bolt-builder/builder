import { useNavigate } from 'react-router';
import { useCliAgents } from '~/lib/hooks/useCliAgents';
import { cn } from '~/utils/cn';

/**
 * Homepage row of CLI coding agent chips. Installed agents open the dedicated
 * full-screen agent console at /agent/:id; missing agents are shown disabled
 * with their install hint.
 */
export function CliAgentLauncher() {
  const navigate = useNavigate();
  const { agents } = useCliAgents();

  if (agents.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-1">
      <span className="text-xs text-devonz-elements-textTertiary mr-1">or chat with a CLI agent</span>
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          disabled={!agent.installed}
          title={agent.installed ? `Open ${agent.name} in the agent console` : `Install with: ${agent.installHint}`}
          className={cn(
            'flex items-center gap-1.5 justify-center h-8 px-3 rounded-lg text-xs font-medium bg-transparent',
            agent.installed
              ? 'text-devonz-elements-textSecondary hover:text-devonz-elements-textPrimary hover:bg-devonz-elements-background-depth-2 cursor-pointer'
              : 'text-devonz-elements-textTertiary opacity-50 cursor-not-allowed',
          )}
          onClick={() => {
            if (agent.installed) {
              navigate(`/agent/${agent.id}`);
            }
          }}
        >
          <span className="i-ph:robot w-3.5 h-3.5" />
          <span>{agent.name}</span>
          {agent.version && <span className="text-devonz-elements-textTertiary">v{agent.version}</span>}
        </button>
      ))}
    </div>
  );
}
