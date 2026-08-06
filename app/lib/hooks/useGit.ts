import type { RuntimeProvider } from '~/lib/runtime/runtime-provider';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { runtime as runtimePromise } from '~/lib/runtime';
import type { GitAuth, PromiseFsClient } from 'isomorphic-git';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import { createScopedLogger } from '~/utils/logger';

interface FileEntry {
  data: Uint8Array | string;
  encoding?: string;
}

const logger = createScopedLogger('Git');

const lookupSavedPassword = (url: string) => {
  const domain = url.split('/')[2];
  const gitCreds = Cookies.get(`git:${domain}`);

  if (!gitCreds) {
    return null;
  }

  try {
    const { username, password } = JSON.parse(gitCreds || '{}');
    return { username, password };
  } catch (error) {
    logger.warn(`Failed to parse Git Cookie ${error}`);
    return null;
  }
};

const saveGitAuth = (url: string, auth: GitAuth) => {
  const domain = url.split('/')[2];
  Cookies.set(`git:${domain}`, JSON.stringify(auth));
};

export function useGit() {
  const [ready, setReady] = useState(false);
  const [runtimeInstance, setRuntimeInstance] = useState<RuntimeProvider>();
  const [fs, setFs] = useState<PromiseFsClient>();
  const fileData = useRef<Record<string, FileEntry>>({});
  useEffect(() => {
    runtimePromise.then((container) => {
      fileData.current = {};
      setRuntimeInstance(container);
      setFs(getFs(container, fileData));
      setReady(true);
    });
  }, []);

  const gitClone = useCallback(
    async (url: string, retryCount = 0) => {
      if (!runtimeInstance || !fs || !ready) {
        throw new Error('Runtime not initialized. Please try again later.');
      }

      fileData.current = {};

      let branch: string | undefined;
      let baseUrl = url;

      if (url.includes('#')) {
        [baseUrl, branch] = url.split('#');
      }

      /*
       * Skip Git initialization for now - let isomorphic-git handle it
       * This avoids potential issues with our manual initialization
       */

      const headers: {
        [x: string]: string;
      } = {
        'User-Agent': 'bolt.diy',
      };

      const auth = lookupSavedPassword(url);

      if (auth) {
        headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
      }

      try {
        // Add a small delay before retrying to allow for network recovery
        if (retryCount > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount));
          logger.debug(`Retrying git clone (attempt ${retryCount + 1})...`);
        }

        const [{ default: git }, { default: http }] = await Promise.all([
          import('isomorphic-git'),
          import('isomorphic-git/http/web'),
        ]);

        await git.clone({
          fs,
          http,
          dir: runtimeInstance.workdir,
          url: baseUrl,
          depth: 1,
          singleBranch: true,
          ref: branch,
          corsProxy: '/api/git-proxy',
          headers,
          onProgress: (event) => {
            logger.trace('Git clone progress:', event);
          },
          onAuth: (baseUrl) => {
            let auth = lookupSavedPassword(baseUrl);

            if (auth) {
              logger.debug('Using saved authentication for', baseUrl);
              return auth;
            }

            logger.info('Repository requires authentication:', baseUrl);

            if (confirm('This repository requires authentication. Would you like to enter your GitHub credentials?')) {
              auth = {
                username: prompt('Enter username') || '',
                password: prompt('Enter password or personal access token') || '',
              };
              return auth;
            } else {
              return { cancel: true };
            }
          },
          onAuthFailure: (baseUrl, _auth) => {
            logger.error(`Authentication failed for ${baseUrl}`);
            toast.error(
              `Authentication failed for ${baseUrl.split('/')[2]}. Please check your credentials and try again.`,
            );
            throw new Error(
              `Authentication failed for ${baseUrl.split('/')[2]}. Please check your credentials and try again.`,
            );
          },
          onAuthSuccess: (baseUrl, auth) => {
            logger.info(`Authentication successful for ${baseUrl}`);
            saveGitAuth(baseUrl, auth);
          },
        });

        const data: Record<string, FileEntry> = {};

        for (const [key, value] of Object.entries(fileData.current)) {
          data[key] = value;
        }

        return { workdir: runtimeInstance.workdir, data };
      } catch (error) {
        logger.error('Git clone error:', error);

        // Handle specific error types
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check for common error patterns
        if (errorMessage.includes('Authentication failed')) {
          toast.error(`Authentication failed. Please check your GitHub credentials and try again.`);
          throw error;
        } else if (
          errorMessage.includes('ENOTFOUND') ||
          errorMessage.includes('ETIMEDOUT') ||
          errorMessage.includes('ECONNREFUSED')
        ) {
          toast.error(`Network error while connecting to repository. Please check your internet connection.`);

          // Retry for network errors, up to 3 times
          if (retryCount < 3) {
            return gitClone(url, retryCount + 1);
          }

          throw new Error(
            `Failed to connect to repository after multiple attempts. Please check your internet connection.`,
          );
        } else if (errorMessage.includes('404')) {
          toast.error(`Repository not found. Please check the URL and make sure the repository exists.`);
          throw new Error(`Repository not found. Please check the URL and make sure the repository exists.`);
        } else if (errorMessage.includes('401')) {
          toast.error(`Unauthorized access to repository. Please connect your GitHub account with proper permissions.`);
          throw new Error(
            `Unauthorized access to repository. Please connect your GitHub account with proper permissions.`,
          );
        } else {
          toast.error(`Failed to clone repository: ${errorMessage}`);
          throw error;
        }
      }
    },
    [runtimeInstance, fs, ready],
  );

  return { ready, gitClone };
}

const getFs = (rt: RuntimeProvider, record: MutableRefObject<Record<string, FileEntry>>) => ({
  promises: {
    readFile: async (path: string, options?: { encoding?: string }) => {
      const encoding = options?.encoding;
      const relativePath = pathUtils.relative(rt.workdir, path);

      try {
        if (encoding) {
          return await rt.fs.readFile(relativePath);
        }

        return await rt.fs.readFileRaw(relativePath);
      } catch {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        err.errno = -2;
        err.syscall = 'open';
        err.path = path;
        throw err;
      }
    },
    writeFile: async (path: string, data: Uint8Array | string, options: { encoding?: string } = {}) => {
      const relativePath = pathUtils.relative(rt.workdir, path);

      if (record.current) {
        record.current[relativePath] = { data, encoding: options?.encoding };
      }

      await rt.fs.writeFile(relativePath, data);
    },
    mkdir: async (path: string, options?: { recursive?: boolean; mode?: number }) => {
      const relativePath = pathUtils.relative(rt.workdir, path);
      await rt.fs.mkdir(relativePath, { recursive: options?.recursive ?? true });
    },
    readdir: async (path: string, options?: { withFileTypes?: boolean }) => {
      const relativePath = pathUtils.relative(rt.workdir, path);

      try {
        if (options?.withFileTypes) {
          /* Wrap DirEntry booleans as methods for isomorphic-git compatibility */
          const entries = await rt.fs.readdir(relativePath);

          return entries.map((entry) => ({
            name: entry.name,
            isFile: () => entry.isFile,
            isDirectory: () => entry.isDirectory,
          }));
        }

        const entries = await rt.fs.readdir(relativePath);

        return entries.map((entry) => entry.name);
      } catch {
        /*
         * readdir can fail with ENOENT (path doesn't exist) or ENOTDIR
         * (path is a file). In both cases, isomorphic-git expects a proper
         * Node.js error. We throw ENOENT which is the safe default —
         * isomorphic-git handles it gracefully during clone/checkout.
         */
        const err = new Error(`ENOENT: no such file or directory, scandir '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        err.errno = -2;
        err.syscall = 'scandir';
        err.path = path;
        throw err;
      }
    },
    rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      const relativePath = pathUtils.relative(rt.workdir, path);
      await rt.fs.rm(relativePath, { ...(options || {}) });
    },
    rmdir: async (path: string, options?: { recursive?: boolean }) => {
      const relativePath = pathUtils.relative(rt.workdir, path);
      await rt.fs.rm(relativePath, { recursive: true, ...options });
    },
    unlink: async (path: string) => {
      const relativePath = pathUtils.relative(rt.workdir, path);

      return await rt.fs.rm(relativePath, { recursive: false });
    },
    stat: async (path: string) => {
      try {
        const relativePath = pathUtils.relative(rt.workdir, path);
        const dirPath = pathUtils.dirname(relativePath);
        const fileName = pathUtils.basename(relativePath);

        // Special handling for .git/index file
        if (relativePath === '.git/index') {
          return {
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
            size: 12,
            mode: 0o100644,
            mtimeMs: Date.now(),
            ctimeMs: Date.now(),
            birthtimeMs: Date.now(),
            atimeMs: Date.now(),
            uid: 1000,
            gid: 1000,
            dev: 1,
            ino: 1,
            nlink: 1,
            rdev: 0,
            blksize: 4096,
            blocks: 1,
            mtime: new Date(),
            ctime: new Date(),
            birthtime: new Date(),
            atime: new Date(),
          };
        }

        const resp = await rt.fs.readdir(dirPath);
        const fileInfo = resp.find((x) => x.name === fileName);

        if (!fileInfo) {
          const err = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          err.errno = -2;
          err.syscall = 'stat';
          err.path = path;
          throw err;
        }

        return {
          isFile: () => fileInfo.isFile,
          isDirectory: () => fileInfo.isDirectory,
          isSymbolicLink: () => false,
          size: fileInfo.isDirectory ? 4096 : 1,
          mode: fileInfo.isDirectory ? 0o040755 : 0o100644,
          mtimeMs: Date.now(),
          ctimeMs: Date.now(),
          birthtimeMs: Date.now(),
          atimeMs: Date.now(),
          uid: 1000,
          gid: 1000,
          dev: 1,
          ino: 1,
          nlink: 1,
          rdev: 0,
          blksize: 4096,
          blocks: 8,
          mtime: new Date(),
          ctime: new Date(),
          birthtime: new Date(),
          atime: new Date(),
        };
      } catch (error: unknown) {
        if (error && typeof error === 'object' && !('code' in error)) {
          Object.assign(error, {
            code: 'ENOENT',
            errno: -2,
            syscall: 'stat',
            path,
          });
        }

        throw error;
      }
    },
    lstat: async (path: string) => {
      return await getFs(rt, record).promises.stat(path);
    },
    readlink: async (path: string) => {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    },
    symlink: async (target: string, path: string) => {
      /*
       * Symlinks are not supported in this runtime adapter.
       * Throw an "operation not supported" error.
       */
      throw new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`);
    },

    chmod: async (_path: string, _mode: number) => {
      /*
       * chmod is a no-op for compatibility — the local runtime
       * handles permissions natively at the OS level.
       */
      return await Promise.resolve();
    },
  },
});

const pathUtils = {
  dirname: (path: string) => {
    // Handle empty or just filename cases
    if (!path || !path.includes('/')) {
      return '.';
    }

    // Remove trailing slashes
    path = path.replace(/\/+$/, '');

    // Get directory part
    return path.split('/').slice(0, -1).join('/') || '/';
  },

  basename: (path: string, ext?: string) => {
    // Remove trailing slashes
    path = path.replace(/\/+$/, '');

    // Get the last part of the path
    const base = path.split('/').pop() || '';

    // If extension is provided, remove it from the result
    if (ext && base.endsWith(ext)) {
      return base.slice(0, -ext.length);
    }

    return base;
  },
  relative: (from: string, to: string): string => {
    // Handle empty inputs
    if (!from || !to) {
      return '.';
    }

    // Normalize paths by removing trailing slashes and splitting
    const normalizePathParts = (p: string) => p.replace(/\/+$/, '').split('/').filter(Boolean);

    const fromParts = normalizePathParts(from);
    const toParts = normalizePathParts(to);

    // Find common parts at the start of both paths
    let commonLength = 0;
    const minLength = Math.min(fromParts.length, toParts.length);

    for (let i = 0; i < minLength; i++) {
      if (fromParts[i] !== toParts[i]) {
        break;
      }

      commonLength++;
    }

    // Calculate the number of "../" needed
    const upCount = fromParts.length - commonLength;

    // Get the remaining path parts we need to append
    const remainingPath = toParts.slice(commonLength);

    // Construct the relative path
    const relativeParts = [...Array(upCount).fill('..'), ...remainingPath];

    // Handle empty result case
    return relativeParts.length === 0 ? '.' : relativeParts.join('/');
  },
};
