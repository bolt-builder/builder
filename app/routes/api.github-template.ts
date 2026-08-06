import { type AppLoadContext, type LoaderFunctionArgs } from 'react-router';
import JSZip from 'jszip';
import { withSecurity } from '~/lib/security';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('GitHubTemplate');

function isCloudflareEnvironment(context: AppLoadContext): boolean {
  const isProduction = process.env.NODE_ENV === 'production';
  const hasCfPagesVars = !!(
    context?.cloudflare?.env?.CF_PAGES ||
    context?.cloudflare?.env?.CF_PAGES_URL ||
    context?.cloudflare?.env?.CF_PAGES_COMMIT_SHA
  );

  return isProduction && hasCfPagesVars;
}

async function fetchRepoContentsCloudflare(repo: string, githubToken?: string) {
  const baseUrl = 'https://api.github.com';

  const repoResponse = await fetch(`${baseUrl}/repos/${repo}`, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'bolt-app',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!repoResponse.ok) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const repoData = (await repoResponse.json()) as { default_branch: string };
  const defaultBranch = repoData.default_branch;

  const treeResponse = await fetch(`${baseUrl}/repos/${repo}/git/trees/${defaultBranch}?recursive=1`, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'bolt-app',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!treeResponse.ok) {
    throw new Error(`Failed to fetch repository tree: ${treeResponse.status}`);
  }

  const treeData = (await treeResponse.json()) as {
    tree: Array<{ path: string; type: string; sha: string; size?: number }>;
  };

  const files = treeData.tree.filter((item: { type: string; path: string; size?: number }) => {
    if (item.type !== 'blob') {
      return false;
    }

    if (item.path.startsWith('.git/')) {
      return false;
    }

    const isLockFile =
      item.path.endsWith('package-lock.json') ||
      item.path.endsWith('yarn.lock') ||
      item.path.endsWith('pnpm-lock.yaml');

    if (!isLockFile && (item.size ?? 0) >= 100000) {
      return false;
    }

    return true;
  });

  const batchSize = 10;
  const fileContents = [];

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchPromises = batch.map(async (file: { path: string; sha: string }) => {
      try {
        const contentResponse = await fetch(`${baseUrl}/repos/${repo}/contents/${file.path}`, {
          signal: AbortSignal.timeout(15_000),
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'bolt-app',
            ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
          },
        });

        if (!contentResponse.ok) {
          logger.warn(`Failed to fetch ${file.path}: ${contentResponse.status}`);
          return null;
        }

        const contentData = (await contentResponse.json()) as { content: string; encoding?: string };
        const content = atob(contentData.content.replace(/\s/g, ''));

        return {
          name: file.path.split('/').pop() || '',
          path: file.path,
          content,
        };
      } catch (error) {
        logger.warn(`Error fetching ${file.path}:`, error);
        return null;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    fileContents.push(...batchResults.filter(Boolean));

    if (i + batchSize < files.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return fileContents;
}

async function fetchRepoContentsZip(repo: string, githubToken?: string) {
  const baseUrl = 'https://api.github.com';

  const releaseResponse = await fetch(`${baseUrl}/repos/${repo}/releases/latest`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'bolt-app',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!releaseResponse.ok) {
    throw new Error(`GitHub API error: ${releaseResponse.status} - ${releaseResponse.statusText}`);
  }

  const releaseData = (await releaseResponse.json()) as { tag_name?: string; zipball_url: string };
  const zipballUrl = releaseData.zipball_url;

  const zipResponse = await fetch(zipballUrl, {
    signal: AbortSignal.timeout(60_000),
    headers: {
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!zipResponse.ok) {
    throw new Error(`Failed to fetch release zipball: ${zipResponse.status}`);
  }

  const zipArrayBuffer = await zipResponse.arrayBuffer();

  const zip = await JSZip.loadAsync(zipArrayBuffer);

  let rootFolderName = '';
  zip.forEach((relativePath) => {
    if (!rootFolderName && relativePath.includes('/')) {
      rootFolderName = relativePath.split('/')[0];
    }
  });

  const promises = Object.keys(zip.files).map(async (filename) => {
    const zipEntry = zip.files[filename];

    if (zipEntry.dir) {
      return null;
    }

    if (filename === rootFolderName) {
      return null;
    }

    let normalizedPath = filename;

    if (rootFolderName && filename.startsWith(rootFolderName + '/')) {
      normalizedPath = filename.substring(rootFolderName.length + 1);
    }

    const content = await zipEntry.async('string');

    return {
      name: normalizedPath.split('/').pop() || '',
      path: normalizedPath,
      content,
    };
  });

  const results = await Promise.all(promises);

  return results.filter(Boolean);
}

async function githubTemplateLoader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo');

  if (!repo) {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Repository name is required', 400));
  }

  try {
    const githubToken =
      context?.cloudflare?.env?.GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.VITE_GITHUB_ACCESS_TOKEN;

    let fileList;

    if (isCloudflareEnvironment(context)) {
      fileList = await fetchRepoContentsCloudflare(repo, githubToken);
    } else {
      fileList = await fetchRepoContentsZip(repo, githubToken);
    }

    const filteredFiles = fileList.filter(
      (file): file is { name: string; path: string; content: string } => file != null && !file.path.startsWith('.git'),
    );

    return successResponse(filteredFiles);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error);
    }

    logger.error('GitHub template fetch failed', error);

    return errorResponse(error instanceof Error ? error : String(error));
  }
}

export const loader = withSecurity(githubTemplateLoader, {
  allowedMethods: ['GET'],
  auth: AUTH_PRESETS.authenticated,
});
