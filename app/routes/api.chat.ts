import { type ActionFunctionArgs } from 'react-router';
import { createDataStream, generateId } from 'ai';
import { chatRequestSchema } from '~/types/api-types';
import {
  MAX_RESPONSE_SEGMENTS,
  MAX_TOKENS,
  MODEL_CONTEXT_LIMITS,
  CONTEXT_THRESHOLD_PCT,
  type FileMap,
} from '~/lib/.server/llm/constants';
import { CONTINUE_PROMPT } from '~/lib/common/prompts/new-prompt';
import { streamText, type Messages, type StreamingOptions } from '~/lib/.server/llm/stream-text';
import SwitchableStream from '~/lib/.server/llm/switchable-stream';
import type { IProviderSetting } from '~/types/model';
import { createScopedLogger } from '~/utils/logger';
import { getFilePaths, selectContext } from '~/lib/.server/llm/select-context';
import type { ContextAnnotation, ProgressAnnotation } from '~/types/context';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDER_LIST, WORK_DIR } from '~/utils/constants';
import { createSummary, shouldSummarize, createMidConversationSummary } from '~/lib/.server/llm/create-summary';
import { extractPropertiesFromMessage } from '~/lib/.server/llm/utils';
import type { DesignScheme } from '~/types/design-scheme';
import { MCPService } from '~/lib/services/mcpService';
import { StreamRecoveryManager } from '~/lib/.server/llm/stream-recovery';
import { ServerOutputParser } from '~/lib/.server/llm/output-parser';
import { STREAMING_PROTOCOL_VERSION } from '~/types/streaming-events';
import type { StreamingEvent } from '~/types/streaming-events';
import type { PlanPhase, TokenBudgetState, ContextWindowConfig } from '~/lib/agent/types';
import { withSecurity } from '~/lib/security';
import { getApiKeysFromCookie, getProviderSettingsFromCookie } from '~/lib/api/cookies';
import { errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import {
  generateBlueprint,
  buildPhaseEvent,
  serializeBlueprintCompact,
  BLUEPRINT_CONTEXT_PREFIX,
} from '~/lib/.server/llm/phase-pipeline';
import {
  getAgentToolSetWithoutExecute,
  shouldUseAgentMode,
  initializeAgentSession,
  incrementAgentIteration,
  getAgentIterationWarning,
  processAgentToolInvocations,
  processAgentToolCall,
  isAgentToolName,
  emitPlanPhaseEvent,
  getAdjustedMaxSteps,
  handleAgentStepReview,
  emitStepBudgetWarning,
  isAgentReviewLoopActive,
} from '~/lib/services/agentChatIntegration';
import { getAgentOrchestrator } from '~/lib/services/agentOrchestratorService';

export const action = withSecurity(chatAction, {
  auth: AUTH_PRESETS.authenticated,
  csrfExempt: true,
  allowedMethods: ['POST'],
  rateLimit: false,
});

const logger = createScopedLogger('api.chat');

/**
 * Look up the maximum context window size for a model by prefix match
 * against MODEL_CONTEXT_LIMITS. Returns 0 when the model is unknown.
 */
function getMaxContextTokensForModel(modelName: string): number {
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelName.startsWith(prefix)) {
      return limit;
    }
  }

  return 0;
}

async function chatAction({ context, request }: ActionFunctionArgs) {
  // Parse and validate request body
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid JSON in request body'));
  }

  const parsed = chatRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    logger.warn('Chat request validation failed:', parsed.error.issues);

    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid request'));
  }

  const {
    messages,
    files,
    promptId,
    contextOptimization,
    enableThinking,
    supabase,
    chatMode,
    designScheme,
    planMode,
    maxLLMSteps,
    agentMode,
    modelRoutingConfig,
    blueprintMode,
  } = parsed.data as {
    messages: Messages;
    files: FileMap | undefined;
    promptId?: string;
    contextOptimization: boolean;
    enableThinking: boolean;
    chatMode: 'discuss' | 'build';
    planMode: boolean;
    designScheme?: DesignScheme;
    supabase?: {
      isConnected: boolean;
      hasSelectedProject: boolean;
      credentials?: {
        anonKey?: string;
        supabaseUrl?: string;
      };
    };
    maxLLMSteps: number;
    agentMode?: boolean;
    modelRoutingConfig?: import('~/lib/.server/llm/model-router').ModelRoutingConfig;
    blueprintMode?: boolean;
  };

  // Determine if agent mode should be active for this request
  const useAgentMode = shouldUseAgentMode({ agentMode });

  /*
   * Agent mode tools (MCP) require user approval in the UI, so the
   * stream can be idle for minutes while the user reviews a tool call.
   * Use a 5-minute timeout to prevent false stream-recovery kills.
   * Normal (non-agent) mode keeps the 45-second timeout.
   */
  const streamRecovery = new StreamRecoveryManager({
    timeout: useAgentMode ? 300_000 : 45_000,
    maxRetries: useAgentMode ? 0 : 2,
    onTimeout: () => {
      logger.warn('Stream timeout - attempting recovery');
    },
  });

  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = getApiKeysFromCookie(cookieHeader);
  const providerSettings: Record<string, IProviderSetting> = getProviderSettingsFromCookie(cookieHeader);

  const stream = new SwitchableStream();

  /*
   * Create a single parser instance that persists across the entire request
   * (including continuation segments when the LLM hits the token limit).
   */
  const parser = new ServerOutputParser();
  stream.setParser(parser);

  const cumulativeUsage = {
    completionTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
  };
  const encoder: TextEncoder = new TextEncoder();
  let progressCounter: number = 1;

  try {
    const mcpService = MCPService.getInstance();
    const totalMessageContent = messages.reduce((acc, message) => acc + message.content, '');
    logger.debug(`Total message length: ${totalMessageContent.split(' ').length}, words`);

    let lastChunk: string | undefined = undefined;

    const dataStream = createDataStream({
      async execute(dataStream) {
        streamRecovery.startMonitoring();

        // ── Structured event protocol handshake ───────────────────────────
        dataStream.writeData({
          bolt_event: {
            type: 'stream_start',
            timestamp: new Date().toISOString(),
            protocol: STREAMING_PROTOCOL_VERSION,
            capabilities: ['file_streaming', 'search_replace_diff', 'phase_tracking'],
          },
        });

        /*
         * Callback that feeds each LLM text delta through the ServerOutputParser
         * and emits resulting structured events via the data stream.
         * Passed to streamText() so the AI SDK's onChunk fires it automatically.
         */
        const onTextDelta = (delta: string): void => {
          const events: StreamingEvent[] = parser.parseChunk(delta);

          for (const event of events) {
            dataStream.writeData({ bolt_event: event });
          }
        };

        const filePaths = getFilePaths(files || {});
        let filteredFiles: FileMap | undefined = undefined;
        let summary: string | undefined = undefined;
        let messageSliceId = 0;

        // ── Per-request agent state (closure-scoped, not persistent) ──────
        let agentPlanPhase: PlanPhase = 'idle';
        let agentStepCount = 0;

        // Orchestrator ref — populated when agent mode is active
        let orchestratorRef: ReturnType<typeof getAgentOrchestrator> | null = null;

        // ── Context-budget summarization state (closure-scoped) ───────────
        let needsContextSummarization = false;
        let contextSummarizationCooldown = 0;

        // Process MCP tool invocations first
        let processedMessages = await mcpService.processToolInvocations(messages, dataStream);

        // Process agent tool invocations when agent mode is enabled
        if (useAgentMode) {
          processedMessages = await processAgentToolInvocations(processedMessages, dataStream);
        }

        if (processedMessages.length > 3) {
          messageSliceId = processedMessages.length - 3;
        }

        const shouldOptimizeContext = filePaths.length > 0 && contextOptimization && processedMessages.length > 3;

        if (!shouldOptimizeContext && filePaths.length > 0 && contextOptimization) {
          logger.info(
            `Skipping context optimization for short chat (${processedMessages.length} messages ≤ 3) — using all files`,
          );
          filteredFiles = files;
        }

        if (shouldOptimizeContext) {
          logger.debug('Generating Chat Summary + Selecting Context (parallel)');

          const optimizationStart = performance.now();
          dataStream.writeData({
            type: 'progress',
            label: 'summary',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Analysing Request',
          } satisfies ProgressAnnotation);

          logger.debug(`Messages count: ${processedMessages.length}`);

          /*
           * Run createSummary and selectContext in parallel.
           * selectContext uses the summary as a hint, but works without one.
           * Running them concurrently saves 5-10s per request.
           */
          const summaryPromise = createSummary({
            messages: [...processedMessages],
            env: context.cloudflare?.env,
            apiKeys,
            providerSettings,
            promptId,
            contextOptimization,
            onFinish(resp) {
              if (resp.usage) {
                logger.debug('createSummary token usage', JSON.stringify(resp.usage));
                cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
              }
            },
          }).catch((err) => {
            logger.warn('createSummary failed — continuing without summary:', err);

            return undefined;
          });

          const contextPromise = selectContext({
            messages: [...processedMessages],
            env: context.cloudflare?.env,
            apiKeys,
            files: files || {},
            providerSettings,
            promptId,
            contextOptimization,
            summary: '', // summary runs in parallel — selectContext works without one
            ...(blueprintMode ? { operationType: 'blueprint' as const } : {}),
            onFinish(resp) {
              if (resp.usage) {
                logger.debug('selectContext token usage', JSON.stringify(resp.usage));
                cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
              }
            },
          }).catch((err) => {
            logger.warn('selectContext failed — falling back to all files:', err);

            return files;
          });

          const [summaryResult, contextResult] = await Promise.all([summaryPromise, contextPromise]);

          summary = summaryResult;
          filteredFiles = contextResult;

          dataStream.writeData({
            type: 'progress',
            label: 'summary',
            status: 'complete',
            order: progressCounter++,
            message: 'Analysis Complete',
          } satisfies ProgressAnnotation);

          if (summary) {
            dataStream.writeMessageAnnotation({
              type: 'chatSummary',
              summary,
              chatId: processedMessages.slice(-1)?.[0]?.id,
            } as ContextAnnotation);
          }

          if (filteredFiles) {
            logger.debug(`files in context : ${JSON.stringify(Object.keys(filteredFiles))}`);

            dataStream.writeMessageAnnotation({
              type: 'codeContext',
              files: Object.keys(filteredFiles).map((key) => {
                let path = key;

                if (path.startsWith(WORK_DIR)) {
                  path = path.replace(WORK_DIR, '');
                }

                return path;
              }),
            } as ContextAnnotation);
          }

          dataStream.writeData({
            type: 'progress',
            label: 'context',
            status: 'complete',
            order: progressCounter++,
            message: 'Code Files Selected',
          } satisfies ProgressAnnotation);

          logger.info(
            `⏱ Total context optimization (parallel): ${(performance.now() - optimizationStart).toFixed(0)}ms`,
          );
        }

        // Merge MCP tools with agent tools when agent mode is enabled
        let combinedTools = mcpService.toolsWithoutExecute;

        if (useAgentMode) {
          logger.info('🤖 Agent mode enabled - merging agent tools');

          const agentTools = getAgentToolSetWithoutExecute();
          const agentToolNames = Object.keys(agentTools);
          const mcpToolNames = Object.keys(mcpService.toolsWithoutExecute);
          logger.info(`🔧 MCP tools available: ${mcpToolNames.length} - [${mcpToolNames.join(', ')}]`);
          logger.info(`🔧 Agent tools available: ${agentToolNames.length} - [${agentToolNames.join(', ')}]`);
          combinedTools = { ...mcpService.toolsWithoutExecute, ...agentTools };
          logger.info(`🔧 Combined tools total: ${Object.keys(combinedTools).length}`);

          // Initialize agent session for this chat
          initializeAgentSession();

          /*
           * ── Register phase-transition checkpoint callback ─────────────
           * The callback is a closure with access to request-scoped data
           * (processedMessages, cumulativeUsage, maxContextTokens) so the
           * orchestrator singleton never stores request-scoped state.
           */
          const orchestrator = getAgentOrchestrator();
          orchestratorRef = orchestrator;

          const requestChatId = processedMessages[0]?.id || crypto.randomUUID();

          orchestrator.setOnPhaseTransition((phase: PlanPhase) => {
            try {
              const checkpointId = crypto.randomUUID();
              const usagePct =
                maxContextTokens > 0 ? Math.min(100, (cumulativeUsage.totalTokens / maxContextTokens) * 100) : -1;

              const tokenBudget: TokenBudgetState = {
                promptTokens: cumulativeUsage.promptTokens,
                completionTokens: cumulativeUsage.completionTokens,
                totalTokens: cumulativeUsage.totalTokens,
                maxContextTokens,
                usagePercentage: usagePct,
                stepsRemaining: 0,
              };

              dataStream.writeData({
                bolt_event: {
                  type: 'agent_checkpoint' as const,
                  timestamp: new Date().toISOString(),
                  checkpointId,
                  phase,
                  chatId: requestChatId,
                  action: 'saved' as const,
                },
              });

              logger.debug('Phase transition checkpoint emitted', {
                checkpointId,
                phase,
                chatId: requestChatId,
                tokenUsage: tokenBudget.usagePercentage >= 0 ? `${tokenBudget.usagePercentage.toFixed(1)}%` : 'unknown',
              });
            } catch (error) {
              logger.error('Checkpoint emission failed:', error instanceof Error ? error.message : String(error));
            }
          });

          // Transition planPhase from idle to planning and emit event
          agentPlanPhase = 'planning';
          emitPlanPhaseEvent(dataStream, 'idle', 'planning');
          orchestrator.notifyPhaseTransition('planning');

          // Notify about agent mode activation
          dataStream.writeData({
            type: 'progress',
            label: 'agent',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Agent Mode Active',
          } satisfies ProgressAnnotation);
        }

        // ── Blueprint generation (when enabled) ──────────────────────────────
        if (blueprintMode) {
          dataStream.writeData({
            type: 'progress',
            label: 'blueprint',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Generating Blueprint',
          } satisfies ProgressAnnotation);

          // Emit blueprint phase event for client phase tracking
          dataStream.writeData({
            bolt_event: {
              type: 'phase_change',
              timestamp: new Date().toISOString(),
              phase: buildPhaseEvent('blueprint'),
              description: 'Generating project blueprint',
            },
          });

          // Extract user's selected model/provider for blueprint defaults
          const lastUserMsg = processedMessages.filter((x) => x.role === 'user').slice(-1)[0];
          const { model: bpModel, provider: bpProvider } = lastUserMsg
            ? extractPropertiesFromMessage(lastUserMsg)
            : { model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER.name };

          try {
            const blueprintResult = await generateBlueprint({
              getModelInstance: (routedProvider: string, routedModel: string) => {
                const prov = PROVIDER_LIST.find((p) => p.name === routedProvider) || DEFAULT_PROVIDER;

                return prov.getModelInstance({
                  model: routedModel,
                  serverEnv: context.cloudflare?.env,
                  apiKeys,
                  providerSettings,
                });
              },
              modelRoutingConfig,
              defaultProvider: bpProvider,
              defaultModel: bpModel,
              systemPrompt: '',
              messages: processedMessages as import('ai').Message[],
              files: files || {},
              env: context.cloudflare?.env,
              apiKeys,
              providerSettings,
              summary,
            });

            if (blueprintResult.success) {
              const compactBlueprint = serializeBlueprintCompact(blueprintResult.blueprint);
              logger.info(`Blueprint generated: "${blueprintResult.blueprint.projectName}"`);

              /*
               * Inject compact blueprint context as a tagged assistant message.
               * runPhasePipeline extracts this and injects it into the plan phase system prompt.
               */
              processedMessages.push({
                id: generateId(),
                role: 'assistant',
                content: `${BLUEPRINT_CONTEXT_PREFIX}${compactBlueprint}`,
              } as import('ai').Message);

              dataStream.writeData({
                type: 'progress',
                label: 'blueprint',
                status: 'complete',
                order: progressCounter++,
                message: 'Blueprint Generated',
              } satisfies ProgressAnnotation);
            } else {
              logger.warn(
                `Blueprint generation failed (${blueprintResult.error.code}): ${blueprintResult.error.message}`,
              );

              // Report error to client — flow falls back to standard pipeline
              dataStream.writeData({
                bolt_event: {
                  type: 'error',
                  timestamp: new Date().toISOString(),
                  code: blueprintResult.error.code,
                  message: `Blueprint generation failed: ${blueprintResult.error.message}`,
                  recoverable: true,
                },
              });

              dataStream.writeData({
                type: 'progress',
                label: 'blueprint',
                status: 'complete',
                order: progressCounter++,
                message: 'Blueprint skipped — using standard pipeline',
              } satisfies ProgressAnnotation);
            }
          } catch (blueprintError) {
            const bpErrMsg = blueprintError instanceof Error ? blueprintError.message : String(blueprintError);
            logger.error(`Blueprint generation threw: ${bpErrMsg}`);

            dataStream.writeData({
              bolt_event: {
                type: 'error',
                timestamp: new Date().toISOString(),
                code: 'GENERATION_FAILED',
                message: `Blueprint generation error: ${bpErrMsg}`,
                recoverable: true,
              },
            });

            dataStream.writeData({
              type: 'progress',
              label: 'blueprint',
              status: 'complete',
              order: progressCounter++,
              message: 'Blueprint skipped — using standard pipeline',
            } satisfies ProgressAnnotation);
          }
        }

        // ── Resolve active model for token budget calculations ──────────
        const lastUserMsgForModel = processedMessages.filter((x) => x.role === 'user').slice(-1)[0];
        const { model: activeModelName } = lastUserMsgForModel
          ? extractPropertiesFromMessage(lastUserMsgForModel)
          : { model: DEFAULT_MODEL };
        const maxContextTokens = getMaxContextTokensForModel(activeModelName);

        let adjustedMaxSteps = useAgentMode ? getAdjustedMaxSteps(maxLLMSteps) : maxLLMSteps;

        const options: StreamingOptions = {
          supabaseConnection: supabase,
          toolChoice: 'auto',
          tools: combinedTools,
          maxSteps: adjustedMaxSteps,
          agentMode: useAgentMode,
          onStepFinish: async ({ toolCalls, usage: stepUsage }) => {
            agentStepCount++;

            // ── Token budget tracking (agent mode only) ────────────────────
            if (useAgentMode) {
              if (stepUsage) {
                cumulativeUsage.promptTokens += stepUsage.promptTokens || 0;
                cumulativeUsage.completionTokens += stepUsage.completionTokens || 0;
                cumulativeUsage.totalTokens += (stepUsage.promptTokens || 0) + (stepUsage.completionTokens || 0);
              }

              const hasUsageData = stepUsage != null;
              const usagePercentage =
                hasUsageData && maxContextTokens > 0
                  ? Math.min(100, (cumulativeUsage.totalTokens / maxContextTokens) * 100)
                  : -1;

              dataStream.writeData({
                bolt_event: {
                  type: 'token_budget_update' as const,
                  timestamp: new Date().toISOString(),
                  promptTokens: cumulativeUsage.promptTokens,
                  completionTokens: cumulativeUsage.completionTokens,
                  totalTokens: cumulativeUsage.totalTokens,
                  maxContextTokens,
                  usagePercentage,
                  stepNumber: agentStepCount,
                },
              });

              logger.debug('Token budget update', {
                step: agentStepCount,
                totalTokens: cumulativeUsage.totalTokens,
                usagePercentage: usagePercentage >= 0 ? usagePercentage.toFixed(1) : 'unknown',
                maxContextTokens,
              });

              // ── Context budget exhaustion check ─────────────────────────
              if (contextSummarizationCooldown === 0 && usagePercentage >= 0) {
                const tokenBudget: TokenBudgetState = {
                  promptTokens: cumulativeUsage.promptTokens,
                  completionTokens: cumulativeUsage.completionTokens,
                  totalTokens: cumulativeUsage.totalTokens,
                  maxContextTokens,
                  usagePercentage,
                  stepsRemaining: 0,
                };

                const contextConfig: ContextWindowConfig = {
                  thresholdPercentage: CONTEXT_THRESHOLD_PCT * 100,
                  safetyMarginPercentage: 10,
                  maxContextTokens,
                };

                if (shouldSummarize(tokenBudget, contextConfig)) {
                  needsContextSummarization = true;
                  logger.info('Context budget threshold exceeded — flagging for mid-conversation summarization', {
                    usagePercentage: usagePercentage.toFixed(1),
                    threshold: contextConfig.thresholdPercentage,
                  });
                }
              }
            }

            // add tool call annotations for frontend processing
            toolCalls.forEach((toolCall) => {
              // Check if it's an agent tool first
              if (useAgentMode && isAgentToolName(toolCall.toolName)) {
                processAgentToolCall(toolCall, dataStream);

                // Increment iteration counter for agent mode
                incrementAgentIteration();

                // Check for iteration warning
                const warning = getAgentIterationWarning();

                if (warning) {
                  logger.warn('Agent iteration warning:', warning);
                }
              } else {
                // Process as MCP tool
                mcpService.processToolCall(toolCall, dataStream);
              }
            });

            // ── Agent self-review integration ───────────────────────────────
            if (useAgentMode) {
              // Transition from planning to executing on first tool call
              if (agentPlanPhase === 'planning') {
                const prevPhase = agentPlanPhase;
                agentPlanPhase = 'executing';
                emitPlanPhaseEvent(dataStream, prevPhase, 'executing');
                orchestratorRef?.notifyPhaseTransition('executing');
              }

              // Check step budget before running self-review
              const remainingSteps = adjustedMaxSteps - agentStepCount;

              if (remainingSteps < 3 && isAgentReviewLoopActive()) {
                emitStepBudgetWarning(dataStream, remainingSteps);
                logger.warn('Skipping self-review: step budget too low', { remainingSteps, agentStepCount });
              } else {
                // Transition to reviewing phase for self-review
                const preReviewPhase = agentPlanPhase;

                if (preReviewPhase === 'executing') {
                  agentPlanPhase = 'reviewing';
                  emitPlanPhaseEvent(dataStream, preReviewPhase, 'reviewing');
                  orchestratorRef?.notifyPhaseTransition('reviewing');
                }

                const reviewResult = await handleAgentStepReview(dataStream, toolCalls);

                // Transition back to executing after review completes
                if (agentPlanPhase === 'reviewing') {
                  agentPlanPhase = 'executing';
                  emitPlanPhaseEvent(dataStream, 'reviewing', 'executing');
                  orchestratorRef?.notifyPhaseTransition('executing');
                }

                if (reviewResult.shouldInjectFix && reviewResult.fixMessage) {
                  logger.info('Self-review injecting fix continuation', {
                    cycle: reviewResult.reviewCycle?.cycleNumber,
                  });
                }
              }
            }
          },
          onFinish: async ({ text: content, finishReason, usage }) => {
            logger.debug('usage', JSON.stringify(usage));

            /*
             * In agent mode, cumulativeUsage is updated per-step in onStepFinish
             * to enable per-step budget events. Only update here for non-agent mode.
             */
            if (usage && !useAgentMode) {
              cumulativeUsage.completionTokens += usage.completionTokens || 0;
              cumulativeUsage.promptTokens += usage.promptTokens || 0;
              cumulativeUsage.totalTokens += usage.totalTokens || 0;
            }

            // ── Decrement context summarization cooldown each continuation cycle ──
            if (contextSummarizationCooldown > 0) {
              contextSummarizationCooldown--;
            }

            const shouldContinueForLength = finishReason === 'length';
            const shouldRebuildForContext = needsContextSummarization;

            if (!shouldContinueForLength && !shouldRebuildForContext) {
              // ── Transition agent phase back to idle when stream completes ──
              if (useAgentMode && agentPlanPhase !== 'idle') {
                const prevPhase = agentPlanPhase;
                agentPlanPhase = 'idle';
                emitPlanPhaseEvent(dataStream, prevPhase, 'idle');
                orchestratorRef?.notifyPhaseTransition('idle');
              }

              dataStream.writeMessageAnnotation({
                type: 'usage',
                value: {
                  completionTokens: cumulativeUsage.completionTokens,
                  promptTokens: cumulativeUsage.promptTokens,
                  totalTokens: cumulativeUsage.totalTokens,
                },
              });
              dataStream.writeData({
                type: 'progress',
                label: 'response',
                status: 'complete',
                order: progressCounter++,
                message: 'Response Generated',
              } satisfies ProgressAnnotation);
              await new Promise((resolve) => setTimeout(resolve, 0));

              // stream.close();
              return;
            }

            if (stream.switches >= MAX_RESPONSE_SEGMENTS) {
              throw Error('Cannot continue message: Maximum segments reached');
            }

            // ── Context-budget rebuild (before continuation) ──────────────
            if (shouldRebuildForContext) {
              needsContextSummarization = false;
              contextSummarizationCooldown = 3;

              try {
                const summaryResult = await createMidConversationSummary(processedMessages, {
                  env: context.cloudflare?.env,
                  apiKeys,
                  providerSettings,
                });

                if (summaryResult) {
                  const PRESERVE_LAST_N = 4;
                  const systemMsgs = processedMessages.filter((m) => m.role === 'system');
                  const nonSystemMsgs = processedMessages.filter((m) => m.role !== 'system');
                  const preservedTail = nonSystemMsgs.slice(-PRESERVE_LAST_N);

                  processedMessages = [
                    ...systemMsgs,
                    {
                      id: generateId(),
                      role: 'assistant' as const,
                      content: `[Previous conversation summary]\n\n${summaryResult.summary}`,
                    } as import('ai').Message,
                    ...preservedTail,
                  ];

                  dataStream.writeData({
                    bolt_event: {
                      type: 'context_summary' as const,
                      timestamp: new Date().toISOString(),
                      originalTokenCount: summaryResult.originalTokenCount,
                      summarizedTokenCount: summaryResult.summarizedTokenCount,
                      messagesRemoved: summaryResult.messagesRemoved,
                      summaryExcerpt: summaryResult.summary.substring(0, 200),
                    },
                  });

                  logger.info(
                    `Context-budget rebuild: ${summaryResult.messagesRemoved} messages summarized, ` +
                      `${summaryResult.originalTokenCount} → ${summaryResult.summarizedTokenCount} tokens`,
                  );
                } else {
                  logger.debug('Mid-conversation summarization skipped (too few messages)');
                }
              } catch (summarizationError) {
                const errMsg =
                  summarizationError instanceof Error ? summarizationError.message : String(summarizationError);
                logger.warn('Mid-conversation summarization failed — continuing with original messages:', errMsg);
              }
            }

            const switchesLeft = MAX_RESPONSE_SEGMENTS - stream.switches;

            if (shouldContinueForLength) {
              logger.info(
                `Reached max token limit (${MAX_TOKENS}): Continuing message (${switchesLeft} switches left)`,
              );
            } else {
              logger.info(`Context-budget continuation (${switchesLeft} switches left)`);
            }

            // ── Recalculate step budget based on current token usage ────
            if (useAgentMode) {
              const currentUsagePct =
                maxContextTokens > 0 ? Math.min(100, (cumulativeUsage.totalTokens / maxContextTokens) * 100) : -1;
              const currentTokenBudget: TokenBudgetState = {
                promptTokens: cumulativeUsage.promptTokens,
                completionTokens: cumulativeUsage.completionTokens,
                totalTokens: cumulativeUsage.totalTokens,
                maxContextTokens,
                usagePercentage: currentUsagePct,
                stepsRemaining: 0,
              };
              const recentContextSummary = contextSummarizationCooldown > 1;
              adjustedMaxSteps = getAdjustedMaxSteps(maxLLMSteps, currentTokenBudget, recentContextSummary);
              options.maxSteps = adjustedMaxSteps;

              if (adjustedMaxSteps < 5) {
                emitStepBudgetWarning(dataStream, adjustedMaxSteps);
              }

              logger.debug('Adjusted step budget for continuation', {
                adjustedMaxSteps,
                usagePercentage: currentUsagePct >= 0 ? currentUsagePct.toFixed(1) : 'unknown',
                recentContextSummary,
              });
            }

            const lastUserMessage = processedMessages.filter((x) => x.role === 'user').slice(-1)[0];

            const { model, provider } = lastUserMessage
              ? extractPropertiesFromMessage(lastUserMessage)
              : { model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER.name };
            processedMessages.push({ id: generateId(), role: 'assistant', content });
            processedMessages.push({
              id: generateId(),
              role: 'user',
              content: `[Model: ${model}]\n\n[Provider: ${provider}]\n\n${CONTINUE_PROMPT}`,
            });

            const result = await streamText({
              messages: [...processedMessages],
              env: context.cloudflare?.env,
              options,
              apiKeys,
              files,
              providerSettings,
              promptId,
              contextOptimization,
              enableThinking,
              contextFiles: filteredFiles,
              chatMode,
              designScheme,
              planMode,
              summary,
              messageSliceId,
              onTextDelta,
              onErrorValidation: (event) => dataStream.writeData({ bolt_event: event }),
              operationType: blueprintMode ? ('blueprint' as const) : undefined,
              modelRoutingConfig,
            });

            result.mergeIntoDataStream(dataStream, { sendReasoning: enableThinking });

            (async () => {
              for await (const part of result.fullStream) {
                if (part.type === 'error') {
                  const error = part.error;
                  logger.error(`${error}`);

                  return;
                }
              }
            })().catch((err) => {
              logger.error('Continuation stream iteration failed:', err);
            });

            return;
          },
        };

        dataStream.writeData({
          type: 'progress',
          label: 'response',
          status: 'in-progress',
          order: progressCounter++,
          message: 'Generating Response',
        } satisfies ProgressAnnotation);

        const streamStart = performance.now();

        const result = await streamText({
          messages: [...processedMessages],
          env: context.cloudflare?.env,
          options,
          apiKeys,
          files,
          providerSettings,
          promptId,
          contextOptimization,
          enableThinking,
          contextFiles: filteredFiles,
          chatMode,
          designScheme,
          planMode,
          summary,
          messageSliceId,
          onTextDelta,
          onErrorValidation: (event) => dataStream.writeData({ bolt_event: event }),
          operationType: blueprintMode ? ('blueprint' as const) : undefined,
          modelRoutingConfig,
          ...(blueprintMode ? { phaseWise: true } : {}),
        });

        (async () => {
          for await (const part of result.fullStream) {
            streamRecovery.updateActivity();

            if (part.type === 'error') {
              const error = part.error;
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error('Streaming error:', error);
              streamRecovery.stop();

              // Enhanced error handling for common streaming issues
              if (errorMessage.includes('Invalid JSON response')) {
                logger.error('Invalid JSON response detected - likely malformed API response');
              } else if (errorMessage.includes('token')) {
                logger.error('Token-related error detected - possible token limit exceeded');
              }

              return;
            }
          }
          streamRecovery.stop();
          logger.info(`⏱ streamText completed in ${(performance.now() - streamStart).toFixed(0)}ms`);
        })().catch((err) => {
          streamRecovery.stop();
          logger.error('Stream iteration failed:', err);
        });
        result.mergeIntoDataStream(dataStream, { sendReasoning: enableThinking });
      },
      onError: (error: unknown) => {
        // Provide more specific error messages for common issues
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes('model') && errorMessage.includes('not found')) {
          return 'Custom error: Invalid model selected. Please check that the model name is correct and available.';
        }

        if (errorMessage.includes('Invalid JSON response')) {
          return 'Custom error: The AI service returned an invalid response. This may be due to an invalid model name, API rate limiting, or server issues. Try selecting a different model or check your API key.';
        }

        if (
          errorMessage.includes('API key') ||
          errorMessage.includes('unauthorized') ||
          errorMessage.includes('authentication')
        ) {
          return 'Custom error: Invalid or missing API key. Please check your API key configuration.';
        }

        if (errorMessage.includes('token') && errorMessage.includes('limit')) {
          return 'Custom error: Token limit exceeded. The conversation is too long for the selected model. Try using a model with larger context window or start a new conversation.';
        }

        if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
          return 'Custom error: API rate limit exceeded. Please wait a moment before trying again.';
        }

        if (errorMessage.includes('network') || errorMessage.includes('timeout')) {
          return 'Custom error: Network error. Please check your internet connection and try again.';
        }

        return `Custom error: ${errorMessage}`;
      },
    }).pipeThrough(
      new TransformStream({
        transform: (chunk, controller) => {
          if (!lastChunk) {
            lastChunk = ' ';
          }

          if (typeof chunk === 'string') {
            if (chunk.startsWith('g') && !lastChunk.startsWith('g')) {
              controller.enqueue(encoder.encode(`0: "<div class=\\"__boltThought__\\">"\n`));
            }

            if (lastChunk.startsWith('g') && !chunk.startsWith('g')) {
              controller.enqueue(encoder.encode(`0: "</div>\\n"\n`));
            }
          }

          lastChunk = chunk;

          let transformedChunk = chunk;

          if (typeof chunk === 'string' && chunk.startsWith('g')) {
            let content = chunk.split(':').slice(1).join(':');

            if (content.endsWith('\n')) {
              content = content.slice(0, content.length - 1);
            }

            transformedChunk = `0:${content}\n`;
          }

          // Convert the string stream to a byte stream
          const str = typeof transformedChunk === 'string' ? transformedChunk : JSON.stringify(transformedChunk);
          controller.enqueue(encoder.encode(str));
        },
      }),
    );

    return new Response(dataStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        'Text-Encoding': 'chunked',
      },
    });
  } catch (error: unknown) {
    logger.error(error);

    const errMsg = error instanceof Error ? error.message : String(error);

    if (errMsg?.includes('API key')) {
      return errorResponse(new AppError(AppErrorType.UNAUTHORIZED, 'Invalid or missing API key'));
    }

    return errorResponse(
      error instanceof Error ? error : new AppError(AppErrorType.INTERNAL, errMsg || 'An unexpected error occurred'),
    );
  }
}
