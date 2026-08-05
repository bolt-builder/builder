import type { RuntimeProvider, SpawnedProcess } from '~/lib/runtime/runtime-provider';
import { atom, type WritableAtom } from 'nanostores';
import type { ITerminal } from '~/types/terminal';
import { newDevonzShellProcess, newShellProcess } from '~/utils/shell';
import { coloredText } from '~/utils/terminal';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('TerminalStore');

export class TerminalStore {
  #runtime: Promise<RuntimeProvider>;
  #terminals: Array<{ terminal: ITerminal; process: SpawnedProcess }> = [];
  #devonzTerminal = newDevonzShellProcess();

  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(true);

  constructor(runtimePromise: Promise<RuntimeProvider>) {
    this.#runtime = runtimePromise;

    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }

  get devonzTerminal() {
    return this.#devonzTerminal;
  }

  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }

  async attachDevonzTerminal(terminal: ITerminal) {
    try {
      const runtime = await this.#runtime;

      if (!runtime) {
        terminal.write(coloredText.red('Runtime not available\n'));

        return;
      }

      await this.#devonzTerminal.init(runtime, terminal);
    } catch (error: unknown) {
      terminal.write(
        coloredText.red('Failed to spawn devonz shell\n\n') + (error instanceof Error ? error.message : String(error)),
      );

      return;
    }
  }

  async attachTerminal(terminal: ITerminal, initialCommand?: string) {
    try {
      const runtime = await this.#runtime;

      if (!runtime) {
        terminal.write(coloredText.red('Runtime not available\n'));

        return;
      }

      const shellProcess = await newShellProcess(runtime, terminal);
      this.#terminals.push({ terminal, process: shellProcess });

      if (initialCommand) {
        /*
         * Interactive shells (bash readline) flush queued stdin with
         * TCSAFLUSH while initializing, so input written too early is
         * silently discarded. Wait until output that looks like a shell
         * prompt arrives before sending the command; fall back after a
         * generous timeout for exotic prompts.
         */
        let sent = false;
        let dispose: (() => void) | null = null;

        const sendOnce = () => {
          if (sent) {
            return;
          }

          sent = true;
          dispose?.();
          shellProcess.write(`${initialCommand}\n`);
        };

        const promptPattern = /[#$%>❯]\s*(\x1b\[[\d;]*[A-Za-z])*\s*$/;

        dispose = shellProcess.onData((data) => {
          if (promptPattern.test(data)) {
            // Small grace period so readline finishes its own init
            setTimeout(sendOnce, 200);
          }
        });

        setTimeout(sendOnce, 4_000);
      }
    } catch (error: unknown) {
      terminal.write(
        coloredText.red('Failed to spawn shell\n\n') + (error instanceof Error ? error.message : String(error)),
      );

      return;
    }
  }

  onTerminalResize(cols: number, rows: number) {
    for (const { process } of this.#terminals) {
      process.resize({ cols, rows });
    }
  }

  async detachTerminal(terminal: ITerminal) {
    const terminalIndex = this.#terminals.findIndex((t) => t.terminal === terminal);

    if (terminalIndex !== -1) {
      const { process } = this.#terminals[terminalIndex];

      try {
        process.kill();
      } catch (error) {
        logger.warn('Failed to kill terminal process:', error);
      }

      this.#terminals.splice(terminalIndex, 1);
    }
  }
}
