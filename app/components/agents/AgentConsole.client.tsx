import { useStore } from '@nanostores/react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Terminal } from '~/components/workbench/terminal/Terminal';
import { csrfFetch } from '~/lib/api/csrf-client';
import { useCliAgents, type CliAgentInfo } from '~/lib/hooks/useCliAgents';
import { themeStore } from '~/lib/stores/theme';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('AgentConsole');

const TERMINAL_ENDPOINT = '/api/runtime/terminal';

type ConsoleStatus = 'connecting' | 'running' | 'exited' | 'error';

interface AgentSession {
  sessionId: string;
  eventSource: EventSource;
}

async function postTerminalOp(body: Record<string, unknown>): Promise<Response> {
  return csrfFetch(TERMINAL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Full-screen console for a single CLI coding agent (Claude Code, Codex, ...).
 *
 * Unlike the workbench terminal tabs, this component owns its own PTY session
 * directly against /api/runtime/terminal: the agent binary is spawned as the
 * session command inside a dedicated per-agent scratch project, so no chat or
 * workbench needs to exist.
 */
export function AgentConsole({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const theme = useStore(themeStore);
  const { agents } = useCliAgents();

  const [status, setStatus] = useState<ConsoleStatus>('connecting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [restartToken, setRestartToken] = useState(0);

  const sessionRef = useRef<AgentSession | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const spawningRef = useRef(false);

  const agent: CliAgentInfo | undefined = agents.find((entry) => entry.id === agentId);
  const agentsLoaded = agents.length > 0;

  const closeSession = useCallback((kill: boolean) => {
    const session = sessionRef.current;
    sessionRef.current = null;

    if (!session) {
      return;
    }

    session.eventSource.close();

    if (kill) {
      postTerminalOp({ op: 'kill', sessionId: session.sessionId }).catch((error) => {
        logger.debug('Failed to kill agent session', error);
      });
    }
  }, []);

  const spawnAgent = useCallback(
    async (terminal: XTerm, agentInfo: CliAgentInfo) => {
      if (spawningRef.current || sessionRef.current) {
        return;
      }

      spawningRef.current = true;
      setStatus('connecting');
      setExitCode(null);
      setErrorMessage(null);

      try {
        const response = await postTerminalOp({
          op: 'spawn',
          projectId: `agent-console-${agentInfo.id}`,
          command: agentInfo.command,
          cols: terminal.cols,
          rows: terminal.rows,
        });

        if (!response.ok) {
          throw new Error(`Failed to start ${agentInfo.name} (HTTP ${response.status})`);
        }

        const json = (await response.json()) as { data?: { sessionId?: string } };
        const sessionId = json.data?.sessionId;

        if (!sessionId) {
          throw new Error('Terminal session did not return a session id');
        }

        const eventSource = new EventSource(
          `${TERMINAL_ENDPOINT}?op=stream&sessionId=${encodeURIComponent(sessionId)}`,
        );

        sessionRef.current = { sessionId, eventSource };

        eventSource.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as { type: string; data?: string; exitCode?: number | null };

            if (message.type === 'connected') {
              setStatus('running');
            } else if (message.type === 'data' && typeof message.data === 'string') {
              terminal.write(message.data);
            } else if (message.type === 'exit') {
              setStatus('exited');
              setExitCode(typeof message.exitCode === 'number' ? message.exitCode : null);
              closeSession(false);
            }
          } catch (error) {
            logger.debug('Failed to parse terminal stream message', error);
          }
        };

        eventSource.onerror = () => {
          // EventSource retries transparently; only surface an error if the session is gone
          if (sessionRef.current?.eventSource !== eventSource) {
            return;
          }
        };
      } catch (error) {
        logger.error('Failed to spawn agent session', error);
        setStatus('error');
        setErrorMessage(error instanceof Error ? error.message : 'Failed to start the agent');
      } finally {
        spawningRef.current = false;
      }
    },
    [closeSession],
  );

  const handleTerminalReady = useCallback(
    (terminal: XTerm) => {
      terminalRef.current = terminal;

      terminal.onData((data) => {
        const session = sessionRef.current;

        if (session) {
          postTerminalOp({ op: 'write', sessionId: session.sessionId, data }).catch((error) => {
            logger.debug('Failed to write to agent session', error);
          });
        }
      });

      if (agent?.installed) {
        spawnAgent(terminal, agent);
      }
    },
    [agent, spawnAgent],
  );

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    const session = sessionRef.current;

    if (session) {
      postTerminalOp({ op: 'resize', sessionId: session.sessionId, cols, rows }).catch((error) => {
        logger.debug('Failed to resize agent session', error);
      });
    }
  }, []);

  // spawn once the agent metadata arrives after the terminal is already mounted
  useEffect(() => {
    const terminal = terminalRef.current;

    if (terminal && agent?.installed && !sessionRef.current) {
      spawnAgent(terminal, agent);
    }
  }, [agent, spawnAgent, restartToken]);

  // kill the session when leaving the page
  useEffect(() => {
    return () => {
      closeSession(true);
    };
  }, [closeSession]);

  const restart = useCallback(() => {
    closeSession(true);
    terminalRef.current?.reset();
    setRestartToken((token) => token + 1);
  }, [closeSession]);

  const statusLabel =
    status === 'running'
      ? 'Running'
      : status === 'connecting'
        ? 'Starting…'
        : status === 'exited'
          ? exitCode === null || exitCode === 0
            ? 'Exited'
            : `Exited (code ${exitCode})`
          : 'Error';

  const statusColor =
    status === 'running' ? 'bg-green-500' : status === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500';

  return (
    <div className="flex flex-col h-full w-full bg-devonz-elements-background-depth-1">
      <header className="flex items-center gap-3 px-4 min-h-[52px] border-b border-devonz-elements-borderColor">
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm text-devonz-elements-textSecondary hover:text-devonz-elements-textPrimary bg-transparent"
          onClick={() => navigate('/')}
          aria-label="Back to home"
        >
          <span className="i-ph:arrow-left" />
          <span>Home</span>
        </button>
        <div className="w-px h-5 bg-devonz-elements-borderColor" />
        <div className="i-ph:robot text-lg text-devonz-elements-textPrimary" />
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-medium text-devonz-elements-textPrimary truncate">
            {agent?.name ?? agentId}
          </span>
          {agent?.version && <span className="text-xs text-devonz-elements-textTertiary">v{agent.version}</span>}
        </div>
        {agent?.installed && (
          <div className="flex items-center gap-1.5 ml-auto">
            <span className={`inline-block w-2 h-2 rounded-full ${statusColor}`} aria-hidden />
            <span className="text-xs text-devonz-elements-textSecondary">{statusLabel}</span>
            {(status === 'exited' || status === 'error') && (
              <button
                type="button"
                className="ml-2 flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-devonz-elements-background-depth-2 text-devonz-elements-textSecondary hover:text-devonz-elements-textPrimary border border-devonz-elements-borderColor"
                onClick={restart}
              >
                <span className="i-ph:arrow-clockwise" />
                Restart
              </button>
            )}
          </div>
        )}
      </header>

      <div className="flex-1 min-h-0 relative">
        {agentsLoaded && !agent && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-devonz-elements-textSecondary">
            <div className="i-ph:robot text-3xl" />
            <p className="text-sm">Unknown agent “{agentId}”.</p>
          </div>
        )}

        {agent && !agent.installed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-devonz-elements-textSecondary px-6 text-center">
            <div className="i-ph:robot text-3xl" />
            <p className="text-sm">{agent.name} is not installed on this machine.</p>
            <code className="text-xs px-3 py-2 rounded-md bg-devonz-elements-background-depth-2 border border-devonz-elements-borderColor select-all">
              {agent.installHint}
            </code>
          </div>
        )}

        {errorMessage && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 text-xs px-3 py-1.5 rounded-md bg-red-500/10 text-red-400 border border-red-500/30">
            {errorMessage}
          </div>
        )}

        <Terminal
          key={restartToken}
          id={`agent-console-${agentId}`}
          className="h-full"
          theme={theme}
          onTerminalReady={handleTerminalReady}
          onTerminalResize={handleTerminalResize}
        />
      </div>
    </div>
  );
}
