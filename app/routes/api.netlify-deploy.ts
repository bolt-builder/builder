import { type ActionFunctionArgs } from 'react-router';
import crypto from 'crypto';
import type { NetlifySiteInfo } from '~/types/netlify';
import { withSecurity } from '~/lib/security';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import { createScopedLogger } from '~/utils/logger';
import { z } from 'zod';

const logger = createScopedLogger('NetlifyDeploy');

const netlifyDeployRequestSchema = z.object({
  siteId: z.string().optional(),
  files: z.record(z.string(), z.string()),
  chatId: z.string(),
  token: z.string().optional(),
});

/** Subset of the Netlify Sites API response we actually use */
interface NetlifyApiSite {
  id: string;
  name: string;
  url: string;
  ssl_url?: string;
}

/** Subset of the Netlify Deploy API response we actually use */
interface NetlifyApiDeploy {
  id: string;
  state: string;
  url: string;
  ssl_url?: string;
  error_message?: string;
  required?: string[];
}

async function readNetlifyError(response: Response) {
  try {
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const data = (await response.json()) as { message?: string; error?: string } | undefined;
      return data?.message || data?.error || JSON.stringify(data);
    }

    const text = await response.text();

    return text;
  } catch {
    return undefined;
  }
}

async function netlifyDeployAction({ request }: ActionFunctionArgs) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid JSON in request body', 400));
  }

  const parsed = netlifyDeployRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    logger.warn('Validation failed:', parsed.error.flatten());

    return errorResponse(
      new AppError(AppErrorType.VALIDATION, 'Invalid request body', 400, {
        details: parsed.error.flatten().fieldErrors,
      }),
    );
  }

  const { siteId, files, token, chatId } = parsed.data;

  try {
    if (!token) {
      return errorResponse(new AppError(AppErrorType.UNAUTHORIZED, 'Not connected to Netlify'));
    }

    let targetSiteId = siteId;
    let siteInfo: NetlifySiteInfo | undefined;

    // If no siteId provided, create a new site
    if (!targetSiteId) {
      const siteName = `bolt-${chatId}-${Date.now()}`;
      const createSiteResponse = await fetch('https://api.netlify.com/api/v1/sites', {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: siteName,
          custom_domain: null,
        }),
      });

      if (!createSiteResponse.ok) {
        const errorDetail = await readNetlifyError(createSiteResponse);

        return errorResponse(
          new AppError(
            AppErrorType.NETWORK,
            `Failed to create site${errorDetail ? `: ${errorDetail}` : ''}`,
            createSiteResponse.status,
          ),
        );
      }

      const newSite = (await createSiteResponse.json()) as NetlifyApiSite;
      targetSiteId = newSite.id;
      siteInfo = {
        id: newSite.id,
        name: newSite.name,
        url: newSite.url,
        chatId,
      };
    } else {
      // Get existing site info
      if (targetSiteId) {
        const siteResponse = await fetch(`https://api.netlify.com/api/v1/sites/${targetSiteId}`, {
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (siteResponse.ok) {
          const existingSite = (await siteResponse.json()) as NetlifyApiSite;
          siteInfo = {
            id: existingSite.id,
            name: existingSite.name,
            url: existingSite.url,
            chatId,
          };
        } else {
          targetSiteId = undefined;
        }
      }

      // If no siteId provided or site doesn't exist, create a new site
      if (!targetSiteId) {
        const siteName = `bolt-${chatId}-${Date.now()}`;
        const createSiteResponse = await fetch('https://api.netlify.com/api/v1/sites', {
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: siteName,
            custom_domain: null,
          }),
        });

        if (!createSiteResponse.ok) {
          const errorDetail = await readNetlifyError(createSiteResponse);

          return errorResponse(
            new AppError(
              AppErrorType.NETWORK,
              `Failed to create site${errorDetail ? `: ${errorDetail}` : ''}`,
              createSiteResponse.status,
            ),
          );
        }

        const newSite = (await createSiteResponse.json()) as NetlifyApiSite;
        targetSiteId = newSite.id;
        siteInfo = {
          id: newSite.id,
          name: newSite.name,
          url: newSite.url,
          chatId,
        };
      }
    }

    // Create file digests
    const fileDigests: Record<string, string> = {};

    for (const [filePath, content] of Object.entries(files)) {
      // Ensure file path starts with a forward slash
      const normalizedPath = filePath.startsWith('/') ? filePath : '/' + filePath;
      const hash = crypto.createHash('sha1').update(content).digest('hex');
      fileDigests[normalizedPath] = hash;
    }

    // Create a new deploy with digests
    const deployResponse = await fetch(`https://api.netlify.com/api/v1/sites/${targetSiteId}/deploys`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: fileDigests,
        async: true,
        skip_processing: false,
        draft: false, // Change this to false for production deployments
        function_schedules: [],
        framework: null,
      }),
    });

    if (!deployResponse.ok) {
      const errorDetail = await readNetlifyError(deployResponse);

      return errorResponse(
        new AppError(
          AppErrorType.NETWORK,
          `Failed to create deployment${errorDetail ? `: ${errorDetail}` : ''}`,
          deployResponse.status,
        ),
      );
    }

    const deploy = (await deployResponse.json()) as NetlifyApiDeploy;
    let retryCount = 0;
    const maxRetries = 60;
    let filesUploaded = false;

    // Poll until deploy is ready for file uploads
    while (retryCount < maxRetries) {
      const statusResponse = await fetch(`https://api.netlify.com/api/v1/sites/${targetSiteId}/deploys/${deploy.id}`, {
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!statusResponse.ok) {
        const errorDetail = await readNetlifyError(statusResponse);

        return errorResponse(
          new AppError(
            AppErrorType.NETWORK,
            `Failed to check deployment status${errorDetail ? `: ${errorDetail}` : ''}`,
            statusResponse.status,
          ),
        );
      }

      const status = (await statusResponse.json()) as NetlifyApiDeploy;

      if (!filesUploaded && (status.state === 'prepared' || status.state === 'uploaded')) {
        // Upload all files regardless of required array
        for (const [filePath, content] of Object.entries(files)) {
          const normalizedPath = filePath.startsWith('/') ? filePath : '/' + filePath;
          const encodedPath = normalizedPath
            .split('/')
            .map((segment) => encodeURIComponent(segment))
            .join('/');

          let uploadSuccess = false;
          let uploadRetries = 0;

          while (!uploadSuccess && uploadRetries < 3) {
            try {
              const uploadResponse = await fetch(
                `https://api.netlify.com/api/v1/deploys/${deploy.id}/files${encodedPath}`,
                {
                  method: 'PUT',
                  signal: AbortSignal.timeout(60_000),
                  headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/octet-stream',
                  },
                  body: content,
                },
              );

              uploadSuccess = uploadResponse.ok;

              if (!uploadSuccess) {
                logger.error('Upload failed:', await uploadResponse.text());
                uploadRetries++;
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
            } catch (error) {
              logger.error('Upload error:', error);
              uploadRetries++;
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }

          if (!uploadSuccess) {
            return errorResponse(new AppError(AppErrorType.NETWORK, `Failed to upload file ${filePath}`, 500));
          }
        }

        filesUploaded = true;
      }

      if (status.state === 'ready') {
        // Only return after files are uploaded
        return successResponse({
          deploy: {
            id: status.id,
            state: status.state,
            url: status.ssl_url || status.url,
          },
          site: siteInfo,
        });
      }

      if (status.state === 'error') {
        return errorResponse(
          new AppError(AppErrorType.NETWORK, status.error_message || 'Deploy preparation failed', 500),
        );
      }

      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (retryCount >= maxRetries) {
      return errorResponse(new AppError(AppErrorType.TIMEOUT, 'Deploy preparation timed out'));
    }

    // Make sure we're returning the deploy ID and site info
    return successResponse({
      deploy: {
        id: deploy.id,
        state: deploy.state,
      },
      site: siteInfo,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error);
    }

    logger.error('Netlify deploy action failed', error);

    return errorResponse(error instanceof Error ? error : String(error));
  }
}

export const action = withSecurity(netlifyDeployAction, { auth: AUTH_PRESETS.authenticated });
