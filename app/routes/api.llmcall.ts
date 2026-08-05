import { type ActionFunctionArgs } from 'react-router';
import { streamText } from '~/lib/.server/llm/stream-text';
import type { ProviderInfo } from '~/types/model';
import { generateText } from 'ai';
import { z } from 'zod';
import { providerSchema } from '~/lib/api/schemas';
import { PROVIDER_LIST } from '~/utils/constants';
import { isReasoningModel, getThinkingProviderOptions, getCompletionTokenLimit } from '~/lib/.server/llm/constants';
import type { ModelInfo } from '~/lib/modules/llm/types';
import { resolveModel } from '~/lib/.server/llm/resolve-model';
import { getApiKeysFromCookie, getProviderSettingsFromCookie } from '~/lib/api/cookies';
import { createScopedLogger } from '~/utils/logger';
import { withSecurity } from '~/lib/security';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';

export const action = withSecurity(llmCallAction, {
  auth: AUTH_PRESETS.authenticated,
  csrfExempt: true,
  allowedMethods: ['POST'],
  rateLimit: false,
});

const logger = createScopedLogger('api.llmcall');

// providerSchema imported from ~/lib/api/schemas

const llmCallRequestSchema = z.object({
  system: z.string().optional().default(''),
  message: z.string().min(1, 'Message is required'),
  model: z.string().min(1, 'Model is required'),
  provider: providerSchema,
  streamOutput: z.boolean().optional().default(false),
});

// getCompletionTokenLimit is imported from ~/lib/.server/llm/constants

function validateTokenLimits(modelDetails: ModelInfo, requestedTokens: number): { valid: boolean; error?: string } {
  const modelMaxTokens = modelDetails.maxTokenAllowed || 128000;
  const maxCompletionTokens = getCompletionTokenLimit(modelDetails);

  // Check against model's context window
  if (requestedTokens > modelMaxTokens) {
    return {
      valid: false,
      error: `Requested tokens (${requestedTokens}) exceed model's context window (${modelMaxTokens}). Please reduce your request size.`,
    };
  }

  // Check against completion token limits
  if (requestedTokens > maxCompletionTokens) {
    return {
      valid: false,
      error: `Requested tokens (${requestedTokens}) exceed model's completion limit (${maxCompletionTokens}). Consider using a model with higher token limits.`,
    };
  }

  return { valid: true };
}

async function llmCallAction({ context, request }: ActionFunctionArgs) {
  // Parse and validate request body
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid JSON in request body'));
  }

  const parsed = llmCallRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    logger.warn('LLM call request validation failed:', parsed.error.issues);

    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid request'));
  }

  const { system, message, model, provider, streamOutput } = parsed.data as {
    system: string;
    message: string;
    model: string;
    provider: ProviderInfo;
    streamOutput?: boolean;
  };

  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = getApiKeysFromCookie(cookieHeader);
  const providerSettings = getProviderSettingsFromCookie(cookieHeader);

  if (streamOutput) {
    try {
      const result = await streamText({
        options: {
          system,
        },
        messages: [
          {
            role: 'user',
            content: `${message}`,
          },
        ],
        env: context.cloudflare?.env,
        apiKeys,
        providerSettings,
      });

      return new Response(result.textStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    } catch (error: unknown) {
      logger.error(error);

      if (error instanceof Error && error.message?.includes('API key')) {
        return errorResponse(new AppError(AppErrorType.UNAUTHORIZED, 'Invalid or missing API key'));
      }

      // Handle token limit errors with helpful messages
      if (
        error instanceof Error &&
        (error.message?.includes('max_tokens') ||
          error.message?.includes('token') ||
          error.message?.includes('exceeds') ||
          error.message?.includes('maximum'))
      ) {
        return errorResponse(
          new AppError(
            AppErrorType.VALIDATION,
            `Token limit error: ${error.message}. Try reducing your request size or using a model with higher token limits.`,
          ),
        );
      }

      return errorResponse(
        error instanceof Error
          ? error
          : new AppError(AppErrorType.INTERNAL, 'An unexpected error occurred during streaming'),
      );
    }
  } else {
    try {
      const providerInfo = PROVIDER_LIST.find((p) => p.name === provider.name);

      if (!providerInfo) {
        throw new Error('Provider not found');
      }

      const modelDetails = await resolveModel({
        provider: providerInfo,
        currentModel: model,
        apiKeys,
        providerSettings,
        serverEnv: context.cloudflare?.env,
        logger,
      });

      const dynamicMaxTokens = getCompletionTokenLimit(modelDetails);

      // Validate token limits before making API request
      const validation = validateTokenLimits(modelDetails, dynamicMaxTokens);

      if (!validation.valid) {
        return errorResponse(new AppError(AppErrorType.VALIDATION, validation.error ?? 'Token limit exceeded'));
      }

      logger.info(`Generating response Provider: ${provider.name}, Model: ${modelDetails.name}`);

      const isReasoning = isReasoningModel(modelDetails.name);
      logger.debug(`Model "${modelDetails.name}" reasoning model: ${isReasoning}`);

      // Use maxCompletionTokens for reasoning models (o1, GPT-5), maxTokens for traditional models
      const tokenParams = isReasoning ? { maxCompletionTokens: dynamicMaxTokens } : { maxTokens: dynamicMaxTokens };

      // Filter out unsupported parameters for reasoning models
      const baseParams = {
        system,
        messages: [
          {
            role: 'user' as const,
            content: `${message}`,
          },
        ],
        model: providerInfo.getModelInstance({
          model: modelDetails.name,
          serverEnv: context.cloudflare?.env,
          apiKeys,
          providerSettings,
        }),
        ...tokenParams,
        toolChoice: 'none' as const,
      };

      // For reasoning models, set temperature to 1 (required by OpenAI API)
      const finalParams = isReasoning
        ? { ...baseParams, temperature: 1 } // Set to 1 for reasoning models (only supported value)
        : { ...baseParams, temperature: 0 };

      // Add thinking providerOptions if the model supports it
      const thinkingOptions = getThinkingProviderOptions(provider.name, modelDetails.name, dynamicMaxTokens);

      if (thinkingOptions) {
        (finalParams as Record<string, unknown>).providerOptions = thinkingOptions;
        logger.info(`Extended thinking enabled for ${provider.name}/${modelDetails.name} in llmcall`);
      }

      logger.debug(`LLM params for "${modelDetails.name}": ${JSON.stringify(tokenParams)}`);

      const result = await generateText(finalParams);
      logger.info(`Generated response`);

      return successResponse(result);
    } catch (error: unknown) {
      logger.error(error);

      if (error instanceof Error && error.message?.includes('API key')) {
        return errorResponse(new AppError(AppErrorType.UNAUTHORIZED, 'Invalid or missing API key'));
      }

      // Handle token limit errors with helpful messages
      if (
        error instanceof Error &&
        (error.message?.includes('max_tokens') ||
          error.message?.includes('token') ||
          error.message?.includes('exceeds') ||
          error.message?.includes('maximum'))
      ) {
        return errorResponse(
          new AppError(
            AppErrorType.VALIDATION,
            `Token limit error: ${error.message}. Try reducing your request size or using a model with higher token limits.`,
          ),
        );
      }

      return errorResponse(
        error instanceof Error ? error : new AppError(AppErrorType.INTERNAL, 'An unexpected error occurred'),
      );
    }
  }
}
