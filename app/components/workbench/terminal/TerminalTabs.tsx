import { useStore } from '@nanostores/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Panel, type ImperativePanelHandle } from 'react-resizable-panels';
import { IconButton } from '~/components/ui/IconButton';
import { shortcutEventEmitter } from '~/lib/hooks';
import { useCliAgents } from '~/lib/hooks/useCliAgents';
import { themeStore } from '~/lib/stores/theme';
import { workbenchStore } from '~/lib/stores/workbench';
import { cn } from '~/utils/cn';
import { Terminal, type TerminalRef } from './Terminal';
import { TerminalManager } from './TerminalManager';
import { createScopedLogger } from '~/utils/logger';
import { toast } from 'sonner';

const logger = createScopedLogger('Terminal');

const MAX_TERMINALS = 5;
export const DEFAULT_TERMINAL_SIZE = 25;

/** Larger default when launching a full-screen TUI agent (Claude Code, Codex, ...). */
const AGENT_TERMINAL_SIZE = 50;

export const TerminalTabs = memo(() => {
  const showTerminal = useStore(workbenchStore.showTerminal);
  const theme = useStore(themeStore);

  const terminalRefs = useRef<Map<number, TerminalRef>>(new Map());
  const terminalPanelRef = useRef<ImperativePanelHandle>(null);
  const terminalToggledByShortcut = useRef(false);

  const [activeTerminal, setActiveTerminal] = useState(0);
  const [terminalCount, setTerminalCount] = useState(0);
  const [isRestarting, setIsRestarting] = useState(false);

  // CLI coding agents (Claude Code, Codex, ...) launchable inside the workspace
  const { agents: cliAgents } = useCliAgents();
  const [agentLabels, setAgentLabels] = useState<Record<number, string>>({});
  const pendingCommandsRef = useRef<Map<number, string>>(new Map());

  const handleReinstallAndRestart = useCallback(async () => {
    if (isRestarting) {
      return;
    }

    setIsRestarting(true);
    setActiveTerminal(0);

    try {
      const shell = workbenchStore.boltTerminal;
      await shell.ready();

      let devCommand = 'npm run dev';

      try {
        const files = workbenchStore.files.get();
        const pkgEntry = Object.entries(files).find(([k]) => k.endsWith('/package.json'));

        if (pkgEntry && pkgEntry[1]?.type === 'file') {
          const pkg = JSON.parse(pkgEntry[1].content || '{}');

          if (pkg.scripts?.dev) {
            devCommand = 'npm run dev';
          } else if (pkg.scripts?.start) {
            devCommand = 'npm start';
          } else if (pkg.scripts?.preview) {
            devCommand = 'npm run preview';
          }
        }
      } catch {
        // use default
      }

      toast.info('Reinstalling dependencies...');

      const installResult = await shell.executeCommand('reinstall', 'npm install --legacy-peer-deps');

      if (installResult && installResult.exitCode !== 0) {
        toast.error('npm install failed — check the terminal for details');
        return;
      }

      toast.info('Starting dev server...');
      shell.executeCommand('restart-dev', devCommand);
    } catch (err) {
      logger.error('Reinstall & restart failed:', err);
      toast.error('Failed to reinstall & restart');
    } finally {
      setIsRestarting(false);
    }
  }, [isRestarting]);

  const addTerminal = () => {
    if (terminalCount < MAX_TERMINALS) {
      setTerminalCount(terminalCount + 1);
      setActiveTerminal(terminalCount + 1);
    }
  };

  const launchCliAgent = (agentName: string, command: string) => {
    if (terminalCount >= MAX_TERMINALS) {
      toast.error('Close a terminal tab first');
      return;
    }

    const newIndex = terminalCount + 1;
    pendingCommandsRef.current.set(newIndex, command);
    setAgentLabels((prev) => ({ ...prev, [newIndex]: agentName }));
    setTerminalCount(newIndex);
    setActiveTerminal(newIndex);
    workbenchStore.toggleTerminal(true);

    // Make sure the panel is actually expanded with enough rows for a TUI
    const panel = terminalPanelRef.current;

    if (panel && panel.getSize() < AGENT_TERMINAL_SIZE) {
      panel.resize(AGENT_TERMINAL_SIZE);
    }
  };

  const closeTerminal = useCallback(
    (index: number) => {
      if (index === 0) {
        return;
      } // Can't close bolt terminal

      const terminalRef = terminalRefs.current.get(index);

      if (terminalRef?.getTerminal) {
        const terminal = terminalRef.getTerminal();

        if (terminal) {
          workbenchStore.detachTerminal(terminal);
        }
      }

      // Remove the terminal from refs
      terminalRefs.current.delete(index);

      // Shift agent labels for tabs above the closed one down by one
      setAgentLabels((prev) => {
        const next: Record<number, string> = {};

        for (const [key, label] of Object.entries(prev)) {
          const i = Number(key);

          if (i < index) {
            next[i] = label;
          } else if (i > index) {
            next[i - 1] = label;
          }
        }

        return next;
      });

      // Adjust terminal count and active terminal
      setTerminalCount(terminalCount - 1);

      if (activeTerminal === index) {
        setActiveTerminal(Math.max(0, index - 1));
      } else if (activeTerminal > index) {
        setActiveTerminal(activeTerminal - 1);
      }
    },
    [activeTerminal, terminalCount],
  );

  useEffect(() => {
    return () => {
      terminalRefs.current.forEach((ref, index) => {
        if (index > 0 && ref?.getTerminal) {
          const terminal = ref.getTerminal();

          if (terminal) {
            workbenchStore.detachTerminal(terminal);
          }
        }
      });
    };
  }, []);

  useEffect(() => {
    const { current: terminal } = terminalPanelRef;

    if (!terminal) {
      return;
    }

    const isCollapsed = terminal.isCollapsed();

    if (!showTerminal && !isCollapsed) {
      terminal.collapse();
    } else if (showTerminal && isCollapsed) {
      terminal.resize(DEFAULT_TERMINAL_SIZE);
    }

    terminalToggledByShortcut.current = false;
  }, [showTerminal]);

  useEffect(() => {
    const unsubscribeFromEventEmitter = shortcutEventEmitter.on('toggleTerminal', () => {
      terminalToggledByShortcut.current = true;
    });

    const unsubscribeFromThemeStore = themeStore.subscribe(() => {
      terminalRefs.current.forEach((ref) => {
        ref?.reloadStyles();
      });
    });

    return () => {
      unsubscribeFromEventEmitter();
      unsubscribeFromThemeStore();
    };
  }, []);

  return (
    <Panel
      ref={terminalPanelRef}
      defaultSize={showTerminal ? DEFAULT_TERMINAL_SIZE : 0}
      minSize={10}
      collapsible
      onExpand={() => {
        if (!terminalToggledByShortcut.current) {
          workbenchStore.toggleTerminal(true);
        }
      }}
      onCollapse={() => {
        if (!terminalToggledByShortcut.current) {
          workbenchStore.toggleTerminal(false);
        }
      }}
    >
      <div className="h-full">
        <div className="h-full flex flex-col" style={{ background: 'var(--bolt-elements-bg-depth-1)' }}>
          <div
            className="flex items-center border-y border-bolt-elements-borderColor gap-1.5 min-h-[34px] p-2"
            style={{ background: 'var(--bolt-elements-bg-depth-1)' }}
          >
            {Array.from({ length: terminalCount + 1 }, (_, index) => {
              const isActive = activeTerminal === index;

              return (
                <React.Fragment key={index}>
                  {index === 0 ? (
                    <button
                      key={index}
                      className={cn(
                        'flex items-center text-sm cursor-pointer gap-1.5 px-3 py-2 h-full whitespace-nowrap rounded-full',
                        {
                          'bg-bolt-elements-terminals-buttonBackground hover:text-bolt-elements-textPrimary': isActive,
                          'bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:bg-bolt-elements-terminals-buttonBackground':
                            !isActive,
                        },
                      )}
                      style={isActive ? { color: '#22D3EE' } : undefined}
                      onClick={() => setActiveTerminal(index)}
                    >
                      <div className="i-ph:terminal-window-duotone text-lg" />
                      Terminal
                    </button>
                  ) : (
                    <React.Fragment>
                      <button
                        key={index}
                        className={cn(
                          'flex items-center text-sm cursor-pointer gap-1.5 px-3 py-2 h-full whitespace-nowrap rounded-full',
                          {
                            'bg-bolt-elements-terminals-buttonBackground': isActive,
                            'bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:bg-bolt-elements-terminals-buttonBackground':
                              !isActive,
                          },
                        )}
                        style={isActive ? { color: '#22D3EE' } : undefined}
                        onClick={() => setActiveTerminal(index)}
                      >
                        <div
                          className={agentLabels[index] ? 'i-ph:robot text-lg' : 'i-ph:terminal-window-duotone text-lg'}
                        />
                        {agentLabels[index] ?? <>Terminal {terminalCount > 1 && index}</>}
                        <button
                          className="bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-transparent rounded"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTerminal(index);
                          }}
                        >
                          <div className="i-ph:x text-xs" />
                        </button>
                      </button>
                    </React.Fragment>
                  )}
                </React.Fragment>
              );
            })}
            {terminalCount < MAX_TERMINALS && (
              <IconButton icon="i-ph:plus" size="md" aria-label="Add terminal" onClick={addTerminal} />
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                title="Launch a CLI coding agent in this workspace"
                aria-label="Launch CLI agent"
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-transparent text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-terminals-buttonBackground transition-all cursor-pointer"
              >
                <div className="i-ph:robot text-sm" />
                Agent
                <div className="i-ph:caret-down text-xs" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className={cn(
                    'min-w-[260px] z-[9999]',
                    'bg-bolt-elements-background-depth-2',
                    'rounded-lg shadow-lg',
                    'border border-bolt-elements-borderColor',
                    'animate-in fade-in-0 zoom-in-95',
                    'py-1',
                  )}
                  sideOffset={5}
                  align="start"
                >
                  {cliAgents.length === 0 && (
                    <div className="px-4 py-2 text-xs text-bolt-elements-textTertiary">Detecting installed CLIs…</div>
                  )}
                  {cliAgents.map((agent) => (
                    <DropdownMenu.Item
                      key={agent.id}
                      disabled={!agent.installed}
                      onClick={() => launchCliAgent(agent.name, agent.command)}
                      className={cn(
                        'flex flex-col items-start w-full px-4 py-2 gap-0.5 rounded-md',
                        agent.installed
                          ? 'cursor-pointer text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive'
                          : 'cursor-default opacity-60 text-bolt-elements-textSecondary',
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <div className="i-ph:robot" />
                        {agent.name}
                        {agent.installed && agent.version && (
                          <span className="text-xs text-bolt-elements-textTertiary">v{agent.version}</span>
                        )}
                      </div>
                      {!agent.installed && (
                        <span className="text-xs font-mono text-bolt-elements-textTertiary">{agent.installHint}</span>
                      )}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <IconButton
              icon="i-ph:arrow-clockwise"
              title="Reset Terminal"
              size="md"
              onClick={() => {
                const ref = terminalRefs.current.get(activeTerminal);

                if (ref?.getTerminal()) {
                  const terminal = ref.getTerminal()!;
                  terminal.clear();
                  terminal.focus();

                  if (activeTerminal === 0) {
                    workbenchStore.attachBoltTerminal(terminal);
                  } else {
                    workbenchStore.attachTerminal(terminal);
                  }
                }
              }}
            />
            <button
              title="Reinstall dependencies and restart dev server"
              disabled={isRestarting}
              onClick={handleReinstallAndRestart}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all',
                isRestarting
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:bg-bolt-elements-terminals-buttonBackground cursor-pointer',
              )}
              style={{ color: '#22D3EE' }}
            >
              <div className={cn('i-ph:rocket-launch text-sm', isRestarting && 'animate-pulse')} />
              {isRestarting ? 'Restarting...' : 'Reinstall & Run'}
            </button>
            <IconButton
              className="ml-auto"
              icon="i-ph:caret-down"
              title="Close"
              size="md"
              onClick={() => workbenchStore.toggleTerminal(false)}
            />
          </div>
          {Array.from({ length: terminalCount + 1 }, (_, index) => {
            const isActive = activeTerminal === index;

            logger.debug(`Starting bolt terminal [${index}]`);

            if (index === 0) {
              return (
                <React.Fragment key={`terminal-container-${index}`}>
                  <Terminal
                    key={`terminal-${index}`}
                    id={`terminal_${index}`}
                    className={cn('h-full overflow-hidden modern-scrollbar-invert', {
                      hidden: !isActive,
                    })}
                    ref={(ref) => {
                      if (ref) {
                        terminalRefs.current.set(index, ref);
                      }
                    }}
                    onTerminalReady={(terminal) => workbenchStore.attachBoltTerminal(terminal)}
                    onTerminalResize={(cols, rows) => workbenchStore.onTerminalResize(cols, rows)}
                    theme={theme}
                  />
                  <TerminalManager
                    terminal={terminalRefs.current.get(index)?.getTerminal() || null}
                    isActive={isActive}
                  />
                </React.Fragment>
              );
            } else {
              return (
                <React.Fragment key={`terminal-container-${index}`}>
                  <Terminal
                    key={`terminal-${index}`}
                    id={`terminal_${index}`}
                    className={cn('modern-scrollbar h-full overflow-hidden', {
                      hidden: !isActive,
                    })}
                    ref={(ref) => {
                      if (ref) {
                        terminalRefs.current.set(index, ref);
                      }
                    }}
                    onTerminalReady={(terminal) =>
                      workbenchStore.attachTerminal(terminal, pendingCommandsRef.current.get(index))
                    }
                    onTerminalResize={(cols, rows) => workbenchStore.onTerminalResize(cols, rows)}
                    theme={theme}
                  />
                  <TerminalManager
                    terminal={terminalRefs.current.get(index)?.getTerminal() || null}
                    isActive={isActive}
                  />
                </React.Fragment>
              );
            }
          })}
        </div>
      </div>
    </Panel>
  );
});
