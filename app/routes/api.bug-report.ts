import { type ActionFunctionArgs } from 'react-router';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { createScopedLogger } from '~/utils/logger';
import { withSecurity } from '~/lib/security';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';

const logger = createScopedLogger('BugReport');

// Rate limiting store (in production, use Redis or similar)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_MAX_ENTRIES = 10_000;

// Input validation schema
const bugReportSchema = z.object({
  title: z.string().min(1, 'Title is required').max(100, 'Title must be 100 characters or less'),
  description: z
    .string()
    .min(10, 'Description must be at least 10 characters')
    .max(2000, 'Description must be 2000 characters or less'),
  stepsToReproduce: z.string().max(1000, 'Steps to reproduce must be 1000 characters or less').optional(),
  expectedBehavior: z.string().max(1000, 'Expected behavior must be 1000 characters or less').optional(),
  contactEmail: z.string().email('Invalid email address').optional().or(z.literal('')),
  includeEnvironmentInfo: z.boolean().default(false),
  environmentInfo: z
    .object({
      browser: z.string().optional(),
      os: z.string().optional(),
      screenResolution: z.string().optional(),
      boltVersion: z.string().optional(),
      aiProviders: z.string().optional(),
      projectType: z.string().optional(),
      currentModel: z.string().optional(),
    })
    .optional(),
});

// Sanitize input to prevent XSS
function sanitizeInput(input: string): string {
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// Rate limiting check
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const key = ip;
  const limit = rateLimitStore.get(key);

  if (!limit || now > limit.resetTime) {
    // Prune expired entries periodically to prevent unbounded Map growth
    if (rateLimitStore.size >= RATE_LIMIT_MAX_ENTRIES) {
      for (const [storedKey, storedValue] of rateLimitStore) {
        if (now > storedValue.resetTime) {
          rateLimitStore.delete(storedKey);
        }
      }
    }

    // Reset window (1 hour)
    rateLimitStore.set(key, { count: 1, resetTime: now + 60 * 60 * 1000 });

    return true;
  }

  if (limit.count >= 5) {
    // Max 5 reports per hour per IP
    return false;
  }

  limit.count += 1;
  rateLimitStore.set(key, limit);

  return true;
}

// Get client IP address
function getClientIP(request: Request): string {
  const cfConnectingIP = request.headers.get('cf-connecting-ip');
  const xForwardedFor = request.headers.get('x-forwarded-for');
  const xRealIP = request.headers.get('x-real-ip');

  return cfConnectingIP || xForwardedFor?.split(',')[0] || xRealIP || 'unknown';
}

// Basic spam detection
function isSpam(title: string, description: string): boolean {
  const spamPatterns = [
    /\b(viagra|casino|poker|loan|debt|credit)\b/i,
    /\b(click here|buy now|limited time)\b/i,
    /\b(make money|work from home|earn \$\$)\b/i,
  ];

  const content = title + ' ' + description;

  return spamPatterns.some((pattern) => pattern.test(content));
}

// Format GitHub issue body
function formatIssueBody(data: z.infer<typeof bugReportSchema>): string {
  let body = '**Bug Report** (User Submitted)\n\n';

  body += `**Description:**\n${data.description}\n\n`;

  if (data.stepsToReproduce) {
    body += `**Steps to Reproduce:**\n${data.stepsToReproduce}\n\n`;
  }

  if (data.expectedBehavior) {
    body += `**Expected Behavior:**\n${data.expectedBehavior}\n\n`;
  }

  if (data.includeEnvironmentInfo && data.environmentInfo) {
    body += `**Environment Info:**\n`;

    if (data.environmentInfo.browser) {
      body += `- Browser: ${data.environmentInfo.browser}\n`;
    }

    if (data.environmentInfo.os) {
      body += `- OS: ${data.environmentInfo.os}\n`;
    }

    if (data.environmentInfo.screenResolution) {
      body += `- Screen: ${data.environmentInfo.screenResolution}\n`;
    }

    if (data.environmentInfo.boltVersion) {
      body += `- Bolt: ${data.environmentInfo.boltVersion}\n`;
    }

    if (data.environmentInfo.aiProviders) {
      body += `- AI Providers: ${data.environmentInfo.aiProviders}\n`;
    }

    if (data.environmentInfo.projectType) {
      body += `- Project Type: ${data.environmentInfo.projectType}\n`;
    }

    if (data.environmentInfo.currentModel) {
      body += `- Current Model: ${data.environmentInfo.currentModel}\n`;
    }

    body += '\n';
  }

  if (data.contactEmail) {
    body += `**Contact:** ${data.contactEmail}\n\n`;
  }

  body += '---\n*Submitted via Bolt bug report feature*';

  return body;
}

async function bugReportAction({ request, context }: ActionFunctionArgs) {
  // Only allow POST requests
  if (request.method !== 'POST') {
    return errorResponse(new AppError(AppErrorType.FORBIDDEN, 'Method not allowed'), 405);
  }

  try {
    // Rate limiting
    const clientIP = getClientIP(request);

    if (!checkRateLimit(clientIP)) {
      return errorResponse(
        new AppError(AppErrorType.RATE_LIMITED, 'Rate limit exceeded. Please wait before submitting another report.'),
        429,
      );
    }

    // Parse and validate request body
    const formData = await request.formData();
    const rawData = Object.fromEntries(formData.entries()) as Record<string, unknown>;

    // Parse environment info if provided
    if (rawData.environmentInfo && typeof rawData.environmentInfo === 'string') {
      try {
        rawData.environmentInfo = JSON.parse(rawData.environmentInfo);
      } catch {
        rawData.environmentInfo = undefined;
      }
    }

    // Convert boolean fields
    rawData.includeEnvironmentInfo = rawData.includeEnvironmentInfo === 'true';

    const validatedData = bugReportSchema.parse(rawData);

    // Sanitize text inputs
    const sanitizedData = {
      ...validatedData,
      title: sanitizeInput(validatedData.title),
      description: sanitizeInput(validatedData.description),
      stepsToReproduce: validatedData.stepsToReproduce ? sanitizeInput(validatedData.stepsToReproduce) : undefined,
      expectedBehavior: validatedData.expectedBehavior ? sanitizeInput(validatedData.expectedBehavior) : undefined,
    };

    // Spam detection
    if (isSpam(sanitizedData.title, sanitizedData.description)) {
      return errorResponse(
        new AppError(
          AppErrorType.VALIDATION,
          'Your report was flagged as potential spam. Please contact support if this is an error.',
        ),
        400,
      );
    }

    // Get GitHub configuration
    const githubToken = context?.cloudflare?.env?.GITHUB_BUG_REPORT_TOKEN || process.env.GITHUB_BUG_REPORT_TOKEN;
    const targetRepo = context?.cloudflare?.env?.BUG_REPORT_REPO || process.env.BUG_REPORT_REPO || 'zebbern/Bolt';

    if (!githubToken) {
      logger.error('GitHub bug report token not configured');
      return errorResponse(
        new AppError(
          AppErrorType.INTERNAL,
          'Bug reporting is not properly configured. Please contact the administrators.',
        ),
        500,
      );
    }

    // Initialize GitHub client
    const octokit = new Octokit({
      auth: githubToken,
      userAgent: 'bolt-bug-reporter',
    });

    // Create GitHub issue
    const [owner, repo] = targetRepo.split('/');
    const issue = await octokit.rest.issues.create({
      owner,
      repo,
      title: sanitizedData.title,
      body: formatIssueBody(sanitizedData),
      labels: ['bug', 'user-reported'],
    });

    return successResponse({
      issueNumber: issue.data.number,
      issueUrl: issue.data.html_url,
      message: 'Bug report submitted successfully!',
    });
  } catch (error) {
    logger.error('Error creating bug report:', error);

    // Handle validation errors
    if (error instanceof z.ZodError) {
      return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid input data'), 400);
    }

    // Handle GitHub API errors
    if (error && typeof error === 'object' && 'status' in error) {
      if (error.status === 401) {
        return errorResponse(
          new AppError(AppErrorType.UNAUTHORIZED, 'GitHub authentication failed. Please contact administrators.'),
          500,
        );
      }

      if (error.status === 403) {
        return errorResponse(
          new AppError(AppErrorType.RATE_LIMITED, 'GitHub rate limit reached. Please try again later.'),
          503,
        );
      }

      if (error.status === 404) {
        return errorResponse(
          new AppError(AppErrorType.NOT_FOUND, 'Target repository not found. Please contact administrators.'),
          500,
        );
      }
    }

    return errorResponse(
      new AppError(AppErrorType.INTERNAL, 'Failed to submit bug report. Please try again later.'),
      500,
    );
  }
}

export const action = withSecurity(bugReportAction, {
  auth: AUTH_PRESETS.authenticated,
  allowedMethods: ['POST'],
  rateLimit: false,
});
