import { type LoaderFunctionArgs } from 'react-router';
import { withSecurity } from '~/lib/security';
import { successResponse } from '~/lib/api/responses';
import { AUTH_PRESETS } from '~/lib/security-config';
import type { ChangelogEntry, VersionCheckResponse } from '~/types/api-types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache: { data: VersionCheckResponse; timestamp: number } | null = null;

/** Clear the cached version-check response (e.g. after a successful update). */
export function clearVersionCheckCache() {
  cache = null;
}

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'Bolt-UpdateCheck',
} as const;

/**
 * GET /api/version-check
 *
 * Compares the local commit hash against the latest commit on main
 * from the GitHub API. Returns whether an update is available,
 * how many commits behind, and a multi-commit changelog.
 * Responses are cached in-memory for 5 minutes.
 */
async function versionCheckLoader(_args: LoaderFunctionArgs) {
  // Return cached response if still fresh
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return successResponse(cache.data);
  }

  const owner = 'zebbern';
  const repo = 'Bolt';
  const branch = 'main';
  const isDocker = process.env.RUNNING_IN_DOCKER === 'true';

  // Get local commit hashes
  let localHash = 'unknown';
  let localFullHash = 'unknown';

  try {
    const { execSync } = await import('child_process');
    localFullHash = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    localHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // git not available or not a git repo
  }

  let remoteHash = 'unknown';
  let remoteFullHash = 'unknown';
  let remoteDate = '';
  let remoteMessage = '';
  let updateAvailable = false;
  let commitsBehind = 0;
  let changelog: ChangelogEntry[] = [];
  let compareUrl = '';
  let error: string | null = null;

  try {
    // Fetch latest commit from GitHub
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${branch}`, {
      headers: GITHUB_HEADERS,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      error = `GitHub API returned ${res.status}`;
    } else {
      const data = (await res.json()) as {
        sha: string;
        commit: { message: string; committer: { date: string } };
      };

      remoteFullHash = data.sha;
      remoteHash = data.sha.substring(0, 7);
      remoteMessage = data.commit.message.split('\n')[0];
      remoteDate = data.commit.committer.date;

      updateAvailable = localHash !== 'unknown' && remoteHash !== 'unknown' && localHash !== remoteHash;

      if (updateAvailable && localFullHash !== 'unknown') {
        compareUrl = `https://github.com/${owner}/${repo}/compare/${localFullHash}...${remoteFullHash}`;

        // Fetch commit comparison for changelog and count
        try {
          const compareRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/compare/${localFullHash}...${branch}`,
            { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(5000) },
          );

          if (compareRes.ok) {
            const compareData = (await compareRes.json()) as {
              ahead_by: number;
              commits: Array<{
                sha: string;
                commit: { message: string; committer: { date: string } };
              }>;
            };

            commitsBehind = compareData.ahead_by;

            changelog = compareData.commits
              .slice(-10)
              .reverse()
              .map((c) => ({
                hash: c.sha.substring(0, 7),
                message: c.commit.message.split('\n')[0],
                date: c.commit.committer.date,
              }));
          }
        } catch {
          // Compare endpoint failed — we still have the basic update info
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to check for updates';
  }

  const response: VersionCheckResponse = {
    local: { hash: localHash, fullHash: localFullHash },
    remote: { hash: remoteHash, fullHash: remoteFullHash, date: remoteDate, message: remoteMessage },
    updateAvailable,
    commitsBehind,
    changelog,
    compareUrl,
    isDocker,
    error,
  };

  // Cache the response
  cache = { data: response, timestamp: Date.now() };

  return successResponse(response);
}

export const loader = withSecurity(versionCheckLoader, {
  auth: AUTH_PRESETS.public,
  allowedMethods: ['GET'],
  rateLimit: false,
});
