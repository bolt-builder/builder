/**
 * @module git-manager
 * Local git integration for project version control.
 *
 * Every project gets a git repo initialized on boot. Commits are created
 * automatically after each LLM response, giving users full undo/redo
 * via git history -- no custom snapshot system needed.
 *
 * @remarks SERVER-ONLY — uses child_process.execSync
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('GitManager');

/** Matches a valid git SHA — 4-40 hex characters. */
const VALID_SHA = /^[a-f0-9]{4,40}$/i;

/**
 * Validate that a string looks like a legitimate git SHA.
 * Prevents shell injection when the value is interpolated into commands.
 */
function assertValidSha(sha: string): void {
  if (!VALID_SHA.test(sha)) {
    throw new Error(`Invalid git SHA: ${sha.substring(0, 50)}`);
  }
}

export interface GitCommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  timestamp: number;
  isoDate: string;
  additions: number;
  deletions: number;
}

function gitExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug(`git command failed: ${cmd} — ${msg}`);
    throw error;
  }
}

function isGitAvailable(): boolean {
  try {
    execSync('git --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

let _gitAvailable: boolean | null = null;

function checkGitAvailable(): boolean {
  if (_gitAvailable === null) {
    _gitAvailable = isGitAvailable();

    if (!_gitAvailable) {
      logger.warn('Git is not available on this system — version history disabled');
    }
  }

  return _gitAvailable;
}

/**
 * Initialize a git repo in the project directory if one doesn't exist.
 * Creates an initial commit so there's always a base to diff against.
 */
export function initGitRepo(projectDir: string): boolean {
  if (!checkGitAvailable()) {
    return false;
  }

  try {
    const gitDir = nodePath.join(projectDir, '.git');

    if (fs.existsSync(gitDir)) {
      return true;
    }

    gitExec('git init', projectDir);
    gitExec('git config user.email "bolt@local"', projectDir);
    gitExec('git config user.name "Bolt"', projectDir);

    const gitignorePath = nodePath.join(projectDir, '.gitignore');

    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n.env.local\ndist/\nbuild/\n.cache/\n');
    }

    gitExec('git add -A', projectDir);
    gitExec('git commit -m "Initial project" --allow-empty', projectDir);

    logger.info(`Git repo initialized at ${projectDir}`);

    return true;
  } catch (error) {
    logger.error('Failed to initialize git repo:', error);
    return false;
  }
}

/**
 * Stage all changes and create a commit.
 * Returns the commit SHA, or null if nothing to commit or git unavailable.
 */
export function autoCommit(projectDir: string, message: string): string | null {
  if (!checkGitAvailable()) {
    return null;
  }

  try {
    gitExec('git add -A', projectDir);

    const status = gitExec('git status --porcelain', projectDir);

    if (!status) {
      return null;
    }

    gitExec(`git commit -m ${JSON.stringify(message)}`, projectDir);

    const sha = gitExec('git rev-parse HEAD', projectDir);
    logger.info(`Auto-commit: ${sha.substring(0, 7)} — ${message}`);

    return sha;
  } catch (error) {
    logger.error('Auto-commit failed:', error);
    return null;
  }
}

/**
 * Get the git log as an array of commit info objects.
 * Includes per-commit insertion/deletion counts via --shortstat.
 */
export function getGitLog(projectDir: string, maxCount = 50): GitCommitInfo[] {
  if (!checkGitAvailable()) {
    return [];
  }

  // Clamp to a safe positive integer to prevent injection via string values
  const safeMax = Math.max(1, Math.min(Math.trunc(Number(maxCount)) || 50, 1000));

  try {
    // Use a unique record separator to reliably split commits
    const sep = '---COMMIT_SEP---';
    const format = `${sep}%n%H%n%h%n%s%n%at%n%aI`;
    const raw = gitExec(`git log --format="${format}" --shortstat -n ${safeMax}`, projectDir);

    if (!raw) {
      return [];
    }

    const blocks = raw.split(sep).filter((b) => b.trim());
    const commits: GitCommitInfo[] = [];

    for (const block of blocks) {
      const lines = block.split('\n').filter((l) => l !== '');

      if (lines.length < 5) {
        continue;
      }

      // Parse shortstat line if present (e.g. " 3 files changed, 18 insertions(+), 13 deletions(-)")
      let additions = 0;
      let deletions = 0;
      const statLine = lines[5] ?? '';
      const insMatch = statLine.match(/(\d+)\s+insertion/);
      const delMatch = statLine.match(/(\d+)\s+deletion/);

      if (insMatch) {
        additions = parseInt(insMatch[1], 10);
      }

      if (delMatch) {
        deletions = parseInt(delMatch[1], 10);
      }

      commits.push({
        sha: lines[0],
        shortSha: lines[1],
        message: lines[2],
        timestamp: parseInt(lines[3], 10) * 1000,
        isoDate: lines[4],
        additions,
        deletions,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Get the diff between the current state and a specific commit.
 */
export function getDiff(projectDir: string, commitSha: string): string {
  if (!checkGitAvailable()) {
    return '';
  }

  assertValidSha(commitSha);

  try {
    return gitExec(`git diff ${commitSha} --stat`, projectDir);
  } catch {
    return '';
  }
}

/**
 * Checkout a specific commit (detached HEAD).
 * Returns true if successful.
 */
export function checkoutCommit(projectDir: string, commitSha: string): boolean {
  if (!checkGitAvailable()) {
    return false;
  }

  assertValidSha(commitSha);

  try {
    gitExec('git add -A', projectDir);

    const status = gitExec('git status --porcelain', projectDir);

    if (status) {
      gitExec('git stash', projectDir);
    }

    gitExec(`git checkout ${commitSha}`, projectDir);
    logger.info(`Checked out commit: ${commitSha.substring(0, 7)}`);

    return true;
  } catch (error) {
    logger.error('Checkout failed:', error);
    return false;
  }
}

/**
 * Return to the main branch tip (undo a detached HEAD checkout).
 */
export function checkoutMain(projectDir: string): boolean {
  if (!checkGitAvailable()) {
    return false;
  }

  try {
    gitExec('git checkout main 2>/dev/null || git checkout master', projectDir);
    return true;
  } catch {
    try {
      const branch = gitExec('git branch --list', projectDir)
        .split('\n')
        .map((b) => b.trim().replace('* ', ''))
        .find((b) => b === 'main' || b === 'master');

      if (branch) {
        gitExec(`git checkout ${branch}`, projectDir);
        return true;
      }
    } catch {
      // Fall through
    }

    return false;
  }
}

/**
 * Get the list of files changed in a specific commit.
 */
export function getCommitFiles(projectDir: string, commitSha: string): string[] {
  if (!checkGitAvailable()) {
    return [];
  }

  assertValidSha(commitSha);

  try {
    const raw = gitExec(`git diff-tree --no-commit-id --name-only -r ${commitSha}`, projectDir);
    return raw ? raw.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Get files changed in a commit WITH their change status (A/M/D/R).
 */
export function getCommitFilesWithStatus(projectDir: string, commitSha: string): { file: string; status: string }[] {
  if (!checkGitAvailable()) {
    return [];
  }

  assertValidSha(commitSha);

  try {
    const raw = gitExec(`git diff-tree --no-commit-id --name-status -r ${commitSha}`, projectDir);

    if (!raw) {
      return [];
    }

    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...fileParts] = line.split('\t');
        return { file: fileParts.join('\t'), status: status.charAt(0) };
      });
  } catch {
    return [];
  }
}

/**
 * Get the unified diff for a specific file in a commit.
 */
export function getFileDiff(projectDir: string, commitSha: string, filePath: string): string {
  if (!checkGitAvailable()) {
    return '';
  }

  assertValidSha(commitSha);

  // Sanitize filePath — only allow safe characters
  const safePath = filePath.replace(/[;&|`$(){}]/g, '');

  try {
    // Check if this is the initial commit (has no parent)
    let hasParent = true;

    try {
      gitExec(`git rev-parse ${commitSha}~1`, projectDir);
    } catch {
      hasParent = false;
    }

    if (hasParent) {
      return gitExec(`git diff ${commitSha}~1 ${commitSha} -- "${safePath}"`, projectDir);
    }

    // For initial commit, show the entire file as added
    return gitExec(`git show ${commitSha} -- "${safePath}"`, projectDir);
  } catch {
    return '';
  }
}

/**
 * Get the full unified diff for an entire commit (all files).
 */
export function getCommitDiff(projectDir: string, commitSha: string): string {
  if (!checkGitAvailable()) {
    return '';
  }

  assertValidSha(commitSha);

  try {
    let hasParent = true;

    try {
      gitExec(`git rev-parse ${commitSha}~1`, projectDir);
    } catch {
      hasParent = false;
    }

    if (hasParent) {
      return gitExec(`git diff ${commitSha}~1 ${commitSha}`, projectDir);
    }

    // Initial commit — show all files as added
    return gitExec(`git show ${commitSha}`, projectDir);
  } catch {
    return '';
  }
}

/**
 * Create a zip archive of the project at a specific commit.
 * Returns the raw zip buffer.
 */
export function archiveCommit(projectDir: string, commitSha: string): Buffer {
  assertValidSha(commitSha);

  try {
    return execSync(`git archive --format=zip ${commitSha}`, {
      cwd: projectDir,
      timeout: 30_000,
      maxBuffer: 100 * 1024 * 1024, // 100MB max
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    logger.error('Archive failed:', error);
    throw error;
  }
}

/**
 * Create a zip of only the changed files in a specific commit.
 * Uses git show to get file contents and packages them with Node's built-in zlib.
 */
export function archiveChangedFiles(projectDir: string, commitSha: string): Buffer {
  assertValidSha(commitSha);

  try {
    const files = getCommitFilesWithStatus(projectDir, commitSha);
    const addedOrModified = files.filter((f) => f.status !== 'D');

    if (addedOrModified.length === 0) {
      throw new Error('No files to archive');
    }

    // Use git archive with pathspec to include only changed files
    const paths = addedOrModified.map((f) => `"${f.file.replace(/[;&|`$(){}]/g, '')}"`).join(' ');

    return execSync(`git archive --format=zip ${commitSha} -- ${paths}`, {
      cwd: projectDir,
      timeout: 30_000,
      maxBuffer: 100 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    logger.error('Archive changed files failed:', error);
    throw error;
  }
}
