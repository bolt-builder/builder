import { useEffect, useState } from 'react';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('useCliAgents');

export interface CliAgentInfo {
  id: string;
  name: string;
  command: string;
  installHint: string;
  installed: boolean;
  version: string | null;
}

/** Module-level cache: CLI installs don't change during a session. */
let cachedAgents: CliAgentInfo[] | null = null;
let inflight: Promise<CliAgentInfo[]> | null = null;

async function fetchCliAgents(): Promise<CliAgentInfo[]> {
  if (cachedAgents) {
    return cachedAgents;
  }

  if (!inflight) {
    inflight = (async () => {
      try {
        const response = await fetch('/api/cli-agents');
        const json = (await response.json()) as { data?: { agents?: CliAgentInfo[] } };
        cachedAgents = json.data?.agents ?? [];

        return cachedAgents;
      } catch (error) {
        logger.error('Failed to detect CLI agents', error);

        return [];
      } finally {
        inflight = null;
      }
    })();
  }

  return inflight;
}

/**
 * Detected coding-agent CLIs (Claude Code, Codex, Gemini CLI, OpenCode,
 * Aider) available on the host machine, for launching inside the
 * workspace terminal.
 */
export function useCliAgents() {
  const [agents, setAgents] = useState<CliAgentInfo[]>(cachedAgents ?? []);

  useEffect(() => {
    let cancelled = false;

    void fetchCliAgents().then((result) => {
      if (!cancelled) {
        setAgents(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return { agents };
}
