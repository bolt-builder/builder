/**
 * @route /api/cli-agents
 * Detects coding-agent CLIs installed on the host machine (Claude Code,
 * Codex CLI, Gemini CLI, OpenCode, Aider) so the workbench can offer to
 * launch them inside the project workspace terminal.
 *
 * GET returns every known agent with `installed` + `version` when found,
 * and an install hint when not.
 */

import { execFile } from 'node:child_process';
import type { LoaderFunctionArgs } from 'react-router';
import { withSecurity } from '~/lib/security';
import { successResponse } from '~/lib/api/responses';
import { AUTH_PRESETS } from '~/lib/security-config';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('CliAgents');

/** How long a `--version` probe may run before we consider the CLI absent. */
const PROBE_TIMEOUT_MS = 8_000;

/** Cache detection results for a while; installs don't change mid-session. */
const CACHE_TTL_MS = 60_000;

export interface CliAgentDescriptor {
  id: string;
  name: string;

  /** Binary to launch inside the project terminal. */
  command: string;

  /** Args used only for the version probe. */
  versionArgs: string[];
  installHint: string;
}

export interface CliAgentStatus extends CliAgentDescriptor {
  installed: boolean;
  version: string | null;
}

export const CLI_AGENTS: CliAgentDescriptor[] = [
  {
    id: 'bolt',
    name: 'Bolt CLI',
    command: 'bolt',
    versionArgs: ['--version'],
    installHint: 'curl -fsSL https://raw.githubusercontent.com/bolt-builder/bolt-cli/dev/install | bash',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    installHint: 'npm install -g @openai/codex',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    versionArgs: ['--version'],
    installHint: 'npm install -g @google/gemini-cli',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    versionArgs: ['--version'],
    installHint: 'npm install -g opencode-ai',
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    versionArgs: ['--version'],
    installHint: 'python -m pip install aider-install && aider-install',
  },
];

let cachedResult: { at: number; agents: CliAgentStatus[] } | null = null;

function probeAgent(agent: CliAgentDescriptor): Promise<CliAgentStatus> {
  return new Promise((resolve) => {
    execFile(
      agent.command,
      agent.versionArgs,
      {
        timeout: PROBE_TIMEOUT_MS,
        shell: process.platform === 'win32',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ...agent, installed: false, version: null });
          return;
        }

        const output = `${stdout}\n${stderr}`.trim();
        const versionMatch = output.match(/\d+\.\d+(\.\d+)?(-[\w.]+)?/);
        resolve({ ...agent, installed: true, version: versionMatch ? versionMatch[0] : output.split('\n')[0] || null });
      },
    );
  });
}

async function cliAgentsLoader(_args: LoaderFunctionArgs) {
  if (cachedResult && Date.now() - cachedResult.at < CACHE_TTL_MS) {
    return successResponse({ agents: cachedResult.agents });
  }

  const agents = await Promise.all(CLI_AGENTS.map(probeAgent));
  cachedResult = { at: Date.now(), agents };
  logger.info(
    `Detected CLI agents: ${
      agents
        .filter((a) => a.installed)
        .map((a) => a.id)
        .join(', ') || 'none'
    }`,
  );

  return successResponse({ agents });
}

export const loader = withSecurity(cliAgentsLoader, { auth: AUTH_PRESETS.authenticated, rateLimit: false });
