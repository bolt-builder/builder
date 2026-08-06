import { type LoaderFunctionArgs } from 'react-router';
import { withSecurity } from '~/lib/security';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import { parseCookies } from '~/lib/api/cookies';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('GitInfo');

/** Apply CORS headers to a response. */
function withCors(response: Response): Response {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  return response;
}

interface GitInfo {
  local: {
    commitHash: string;
    branch: string;
    commitTime: string;
    author: string;
    email: string;
    remoteUrl: string;
    repoName: string;
  };
  github?: {
    currentRepo?: {
      fullName: string;
      defaultBranch: string;
      stars: number;
      forks: number;
      openIssues?: number;
    };
  };
  isForked?: boolean;
  timestamp?: string;
}

// Define context type
interface AppContext {
  env?: {
    GITHUB_ACCESS_TOKEN?: string;
  };
}

interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  languages_url: string;
}

interface GitHubGist {
  id: string;
  html_url: string;
  description: string;
}

// These values will be replaced at build time
declare const __COMMIT_HASH: string;
declare const __GIT_BRANCH: string;
declare const __GIT_COMMIT_TIME: string;
declare const __GIT_AUTHOR: string;
declare const __GIT_EMAIL: string;
declare const __GIT_REMOTE_URL: string;
declare const __GIT_REPO_NAME: string;

/*
 * Remove unused variable to fix linter error
 * declare const __GIT_REPO_URL: string;
 */

async function gitInfoSystemLoader({ request, context }: LoaderFunctionArgs & { context: AppContext }) {
  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  if (action === 'getUser' || action === 'getRepos' || action === 'getOrgs' || action === 'getActivity') {
    // Use server-side token instead of client-side token
    const serverGithubToken = process.env.GITHUB_ACCESS_TOKEN || context.env?.GITHUB_ACCESS_TOKEN;
    const cookies = parseCookies(request.headers.get('Cookie'));
    const cookieToken = cookies.githubToken;

    // Also check for token in Authorization header
    const authHeader = request.headers.get('Authorization');
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

    const token = serverGithubToken || headerToken || cookieToken;

    if (!token) {
      logger.error('No GitHub token available');
      return withCors(errorResponse(new AppError(AppErrorType.UNAUTHORIZED, 'No GitHub token available', 401)));
    }

    try {
      if (action === 'getUser') {
        const response = await fetch('https://api.github.com/user', {
          signal: AbortSignal.timeout(15_000),
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          logger.error('GitHub user API error:', response.status);
          throw new Error(`GitHub API error: ${response.status}`);
        }

        const userData = await response.json();

        return withCors(successResponse({ user: userData }));
      }

      if (action === 'getRepos') {
        const reposResponse = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
          signal: AbortSignal.timeout(15_000),
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (!reposResponse.ok) {
          logger.error('GitHub repos API error:', reposResponse.status);
          throw new Error(`GitHub API error: ${reposResponse.status}`);
        }

        const repos = (await reposResponse.json()) as GitHubRepo[];

        // Get user's gists
        const gistsResponse = await fetch('https://api.github.com/gists', {
          signal: AbortSignal.timeout(15_000),
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token}`,
          },
        });

        const gists = gistsResponse.ok ? ((await gistsResponse.json()) as GitHubGist[]) : [];

        // Calculate language statistics
        const languageStats: Record<string, number> = {};
        let totalStars = 0;
        let totalForks = 0;

        for (const repo of repos) {
          totalStars += repo.stargazers_count || 0;
          totalForks += repo.forks_count || 0;

          if (repo.language && repo.language !== 'null') {
            languageStats[repo.language] = (languageStats[repo.language] || 0) + 1;
          }

          /*
           * Optionally fetch languages for each repo for more accurate stats
           * This is commented out to avoid rate limiting
           *
           * if (repo.languages_url) {
           *   try {
           *     const langResponse = await fetch(repo.languages_url, {
           *       headers: {
           *         Accept: 'application/vnd.github.v3+json',
           *         Authorization: `Bearer ${token}`,
           *       },
           *     });
           *
           *     if (langResponse.ok) {
           *       const languages = await langResponse.json();
           *       Object.keys(languages).forEach(lang => {
           *         languageStats[lang] = (languageStats[lang] || 0) + languages[lang];
           *       });
           *     }
           *   } catch (error) {
           *     console.error(`Error fetching languages for ${repo.name}:`, error);
           *   }
           * }
           */
        }

        return withCors(
          successResponse({
            repos,
            stats: {
              totalStars,
              totalForks,
              languages: languageStats,
              totalGists: gists.length,
            },
          }),
        );
      }

      if (action === 'getOrgs') {
        const response = await fetch('https://api.github.com/user/orgs', {
          signal: AbortSignal.timeout(15_000),
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          logger.error('GitHub orgs API error:', response.status);
          throw new Error(`GitHub API error: ${response.status}`);
        }

        const orgs = await response.json();

        return withCors(successResponse({ organizations: orgs }));
      }

      if (action === 'getActivity') {
        const username = cookies.githubUsername;

        if (!username) {
          logger.error('GitHub username not found in cookies');
          return withCors(
            errorResponse(new AppError(AppErrorType.VALIDATION, 'GitHub username not found in cookies', 400)),
          );
        }

        const response = await fetch(`https://api.github.com/users/${username}/events?per_page=30`, {
          signal: AbortSignal.timeout(15_000),
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          logger.error('GitHub activity API error:', response.status);
          throw new Error(`GitHub API error: ${response.status}`);
        }

        const events = await response.json();

        return withCors(successResponse({ recentActivity: events }));
      }
    } catch (error) {
      logger.error('GitHub API error:', error);
      return withCors(
        errorResponse(error instanceof Error ? error : new AppError(AppErrorType.INTERNAL, 'Unknown error')),
      );
    }
  }

  const gitInfo: GitInfo = {
    local: {
      commitHash: typeof __COMMIT_HASH !== 'undefined' ? __COMMIT_HASH : 'development',
      branch: typeof __GIT_BRANCH !== 'undefined' ? __GIT_BRANCH : 'main',
      commitTime: typeof __GIT_COMMIT_TIME !== 'undefined' ? __GIT_COMMIT_TIME : new Date().toISOString(),
      author: typeof __GIT_AUTHOR !== 'undefined' ? __GIT_AUTHOR : 'development',
      email: typeof __GIT_EMAIL !== 'undefined' ? __GIT_EMAIL : 'development@local',
      remoteUrl: typeof __GIT_REMOTE_URL !== 'undefined' ? __GIT_REMOTE_URL : 'local',
      repoName: typeof __GIT_REPO_NAME !== 'undefined' ? __GIT_REPO_NAME : 'bolt.diy',
    },
    timestamp: new Date().toISOString(),
  };

  return withCors(successResponse(gitInfo));
}

export const loader = withSecurity(gitInfoSystemLoader, {
  auth: AUTH_PRESETS.public,
  allowedMethods: ['GET'],
  rateLimit: false,
});
