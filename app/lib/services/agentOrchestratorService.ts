/**
 * Agent Orchestrator Service
 *
 * Manages the autonomous agent execution loop with state tracking,
 * approval flows, iteration limits, and tool coordination.
 */

import { createScopedLogger } from '~/utils/logger';
import type {
  AgentExecutionState,
  AgentModeSettings,
  AgentOrchestratorOptions,
  AgentStatus,
  ToolCallRecord,
  ApprovalRequest,
  ReviewCycle,
  GetErrorsResult,
  ErrorInfo,
  PlanPhase,
} from '~/lib/agent/types';
import { DEFAULT_AGENT_SETTINGS } from '~/lib/agent/types';

const logger = createScopedLogger('AgentOrchestrator');

/** Maximum self-review cycles before terminating the review loop */
const MAX_REVIEW_CYCLES = 3;

/** Number of identical error-state fingerprints before breaking the loop */
const MAX_IDENTICAL_STATES = 2;

/** Tools that modify files and may introduce errors requiring review */
const FILE_WRITE_TOOLS = new Set(['bolt_write_file', 'bolt_update_plan']);

/**
 * FNV-1a 32-bit hash — produces a stable hex fingerprint.
 * Reused pattern from phase-pipeline.ts for loop detection.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Classify an error message into a category for the fix instruction.
 * Follows classification patterns from autoFixService.ts.
 */
function classifySelfReviewError(error: ErrorInfo): string {
  const content = error.content ?? error.message;

  if (/Failed to resolve import|Cannot find module/.test(content)) {
    return 'import-resolution';
  }

  if (/SyntaxError|Unexpected token|Unterminated/.test(content)) {
    return 'syntax';
  }

  if (/Type.*is not assignable|Property.*does not exist|Argument of type/.test(content)) {
    return 'type';
  }

  if (/EADDRINUSE|port.*already in use/i.test(content)) {
    return 'port-conflict';
  }

  if (/Cannot read propert|undefined is not|null is not/.test(content)) {
    return 'runtime';
  }

  if (/vite|esbuild|rollup|bundle/i.test(content)) {
    return 'build';
  }

  return 'unknown';
}

/**
 * Result of a self-review step.
 * The caller uses this to decide whether to inject a continuation message.
 */
export interface SelfReviewResult {
  /** Whether errors were detected and a fix message should be injected */
  shouldInjectFix: boolean;

  /** The continuation message to inject into the conversation (if shouldInjectFix) */
  fixMessage?: string;

  /** Whether the review loop was terminated (max cycles or repeated state) */
  loopTerminated: boolean;

  /** Reason the loop was terminated, if applicable */
  terminationReason?: 'max_cycles_reached' | 'repeated_error_state';

  /** Current review cycle data */
  reviewCycle?: ReviewCycle;
}

function createInitialState(): AgentExecutionState {
  return {
    status: 'idle',
    isExecuting: false,
    iteration: 0,
    maxIterations: DEFAULT_AGENT_SETTINGS.maxIterations,
    totalToolCalls: 0,
    toolCalls: [],
    filesCreated: [],
    filesModified: [],
    commandsExecuted: [],
    sessionStartTime: null,
    planPhase: 'idle',
    subTasks: [],
    memoryRefs: [],
  };
}

export class AgentOrchestrator {
  private _state: AgentExecutionState;
  private _settings: AgentModeSettings;
  private _options: AgentOrchestratorOptions;

  /** Per-session fingerprint history for loop detection */
  private _reviewFingerprints: string[] = [];

  /** Per-session review cycle counter */
  private _reviewCycleCount = 0;

  /** Callback invoked on plan phase transitions — registered by the request-scoped closure */
  private _onPhaseTransition: ((phase: PlanPhase) => void) | null = null;

  constructor(settings: Partial<AgentModeSettings> = {}, options: Partial<AgentOrchestratorOptions> = {}) {
    this._settings = { ...DEFAULT_AGENT_SETTINGS, ...settings };
    this._options = options;
    this._state = createInitialState();
    this._state.maxIterations = this._settings.maxIterations;
    logger.debug('AgentOrchestrator initialized', { settings: this._settings });
  }

  /**
   * Register a callback that fires on plan phase transitions.
   * The callback is typically a closure with access to request-scoped data
   * (messages, tokenBudget) so the orchestrator singleton never holds that data.
   */
  setOnPhaseTransition(callback: (phase: PlanPhase) => void): void {
    this._onPhaseTransition = callback;
  }

  /**
   * Notify that a plan phase transition has occurred.
   * Invokes the registered callback (if any) in a fire-and-forget manner.
   */
  notifyPhaseTransition(phase: PlanPhase): void {
    if (this._onPhaseTransition) {
      try {
        this._onPhaseTransition(phase);
      } catch (error) {
        logger.error('onPhaseTransition callback failed:', error instanceof Error ? error.message : String(error));
      }
    }
  }

  getState(): Readonly<AgentExecutionState> {
    return { ...this._state };
  }

  getSettings(): Readonly<AgentModeSettings> {
    return { ...this._settings };
  }

  updateSettings(updates: Partial<AgentModeSettings>): void {
    this._settings = { ...this._settings, ...updates };
    this._state.maxIterations = this._settings.maxIterations;
    logger.debug('Settings updated', { updates });
  }

  startSession(task: string): void {
    this._state = createInitialState();
    this._state.currentTask = task;
    this._state.status = 'thinking';
    this._state.sessionStartTime = Date.now();
    this._state.maxIterations = this._settings.maxIterations;
    this._reviewFingerprints = [];
    this._reviewCycleCount = 0;
    logger.info('Session started', { task });
    this._notifyStatusChange('thinking');
  }

  endSession(): AgentExecutionState {
    this._state.status = 'completed';
    this._state.sessionEndTime = Date.now();
    logger.info('Session ended', this.getSessionSummary());
    this._notifyStatusChange('completed');

    return this.getState();
  }

  reset(): void {
    this._state = createInitialState();
    this._state.maxIterations = this._settings.maxIterations;
    this._reviewFingerprints = [];
    this._reviewCycleCount = 0;
    this._onPhaseTransition = null;
    logger.debug('State reset');
    this._notifyStatusChange('idle');
  }

  canContinue(): boolean {
    if (this._state.status === 'error') {
      return false;
    }

    return this._state.iteration < this._state.maxIterations;
  }

  async executeTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const { isAgentTool, executeAgentTool } = await import('./agentToolsService');

    if (!isAgentTool(toolName)) {
      const error = `Unknown agent tool: ${toolName}`;
      logger.error(error);

      return { success: false, error };
    }

    const needsApproval = this._checkNeedsApproval(toolName, params);

    if (needsApproval && !this._options.autoApproveAll) {
      const approved = await this._requestApproval({
        toolName,
        params,
        reason: `Tool ${toolName} requires approval`,
      });

      if (!approved) {
        return { success: false, error: 'Tool execution not approved by user' };
      }
    }

    this._state.status = 'executing';
    this._notifyStatusChange('executing');

    const startTime = Date.now();

    try {
      const result = await executeAgentTool(toolName, params);
      const duration = Date.now() - startTime;

      const record: ToolCallRecord = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        name: toolName,
        params,
        result,
        timestamp: startTime,
        duration,
      };

      this._state.toolCalls.push(record);
      this._state.totalToolCalls++;
      this._state.lastToolCall = record;

      if (result.success && result.data) {
        const data = result.data as Record<string, unknown>;

        if (data.created && data.path) {
          this._state.filesCreated.push(data.path as string);
        } else if (data.modified && data.path) {
          this._state.filesModified.push(data.path as string);
        } else if (toolName === 'bolt_write_file' && data.path) {
          this._state.filesCreated.push(data.path as string);
        }

        if (toolName === 'bolt_run_command' && params.command) {
          this._state.commandsExecuted.push(params.command as string);
        }
      }

      this._options.onToolExecuted?.(record);

      this._state.status = 'thinking';
      this._notifyStatusChange('thinking');

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Tool execution failed', { toolName, error: errorMessage });

      return { success: false, error: errorMessage };
    }
  }

  private _checkNeedsApproval(toolName: string, params: Record<string, unknown>): boolean {
    if (toolName === 'bolt_run_command' && !this._settings.autoApproveCommands) {
      return true;
    }

    if (toolName === 'bolt_write_file') {
      const path = params.path as string | undefined;

      if (path && !this._settings.autoApproveFileCreation) {
        return true;
      }
    }

    return false;
  }

  private async _requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (!this._options.onApprovalNeeded) {
      return false;
    }

    this._state.status = 'waiting_for_approval';
    this._state.pendingApproval = request;
    this._notifyStatusChange('waiting_for_approval');

    try {
      const approved = await this._options.onApprovalNeeded(request);
      this._state.pendingApproval = undefined;

      return approved;
    } catch {
      this._state.pendingApproval = undefined;
      return false;
    }
  }

  incrementIteration(): boolean {
    this._state.iteration++;
    logger.debug('Iteration incremented', { iteration: this._state.iteration });
    this._options.onIterationComplete?.(this._state.iteration, this.getState());

    return this.canContinue();
  }

  isNearIterationLimit(): boolean {
    const threshold = 5;
    return this._state.maxIterations - this._state.iteration <= threshold;
  }

  getIterationWarningPrompt(): string | null {
    if (!this.isNearIterationLimit()) {
      return null;
    }

    return `You are nearing the maximum number of iterations (${this._state.maxIterations}). Summarize progress, list remaining tasks, and leave the project in a stable state.`;
  }

  setError(message: string): void {
    this._state.status = 'error';
    this._state.errorMessage = message;
    logger.error('Error set', { message });
    this._notifyStatusChange('error');
  }

  getSessionSummary(): string {
    const parts: string[] = [];
    parts.push(`${this._state.iteration} iterations`);
    parts.push(`${this._state.totalToolCalls} tool calls`);

    if (this._state.filesCreated.length > 0) {
      parts.push(`Files created: ${this._state.filesCreated.join(', ')}`);
    }

    if (this._state.filesModified.length > 0) {
      parts.push(`Files modified: ${this._state.filesModified.join(', ')}`);
    }

    if (this._state.commandsExecuted.length > 0) {
      parts.push(`Commands: ${this._state.commandsExecuted.join(', ')}`);
    }

    return parts.join(' | ');
  }

  abort(): void {
    this._state.status = 'idle';
    this._state.isExecuting = false;
    logger.info('Execution aborted');
    this._notifyStatusChange('idle');
  }

  // ─── Self-Review Loop ───────────────────────────────────────────────

  /**
   * Main entry point for self-review after an onStepFinish batch.
   *
   * Call this with the tool calls from a completed step. If file-write
   * tools are detected, the orchestrator programmatically runs
   * bolt_get_errors, classifies the results, tracks the cycle with
   * FNV-1a fingerprinting, and returns a structured result indicating
   * whether a fix continuation message should be injected.
   */
  async handleStepFinishReview(toolCalls: ReadonlyArray<{ toolName: string }>): Promise<SelfReviewResult> {
    if (!this._hasFileWriteTools(toolCalls)) {
      return { shouldInjectFix: false, loopTerminated: false };
    }

    // Check if we've already hit the cycle cap
    if (this._reviewCycleCount >= MAX_REVIEW_CYCLES) {
      logger.warn('Self-review loop terminated: max cycles reached', {
        cycleCount: this._reviewCycleCount,
      });

      return {
        shouldInjectFix: false,
        loopTerminated: true,
        terminationReason: 'max_cycles_reached',
      };
    }

    // Programmatically invoke bolt_get_errors
    const errorsResult = await this._fetchErrors();

    if (!errorsResult || !errorsResult.hasErrors || errorsResult.count === 0) {
      logger.debug('Self-review: no errors detected after file writes');

      // Clear review cycle — the code is clean
      this._state.reviewCycle = undefined;

      return { shouldInjectFix: false, loopTerminated: false };
    }

    // Classify errors and compute fingerprint
    const errors = errorsResult.errors as ErrorInfo[];
    const fingerprint = this._computeErrorFingerprint(errors);

    // Check for repeated error state
    if (this._isRepeatedErrorState(fingerprint)) {
      logger.warn('Self-review loop terminated: repeated error state detected', {
        fingerprint,
        cycleCount: this._reviewCycleCount,
      });

      // Update state to reflect the termination
      this._state.reviewCycle = {
        cycleNumber: this._reviewCycleCount + 1,
        triggeredBy: 'error-detection',
        errorsFound: errors.map((e) => e.message),
        fixAttempted: false,
        fingerprint,
      };

      return {
        shouldInjectFix: false,
        loopTerminated: true,
        terminationReason: 'repeated_error_state',
        reviewCycle: this._state.reviewCycle,
      };
    }

    // Record this fingerprint and advance the cycle
    this._reviewFingerprints.push(fingerprint);
    this._reviewCycleCount++;

    const reviewCycle: ReviewCycle = {
      cycleNumber: this._reviewCycleCount,
      triggeredBy: 'error-detection',
      errorsFound: errors.map((e) => e.message),
      fixAttempted: true,
      fingerprint,
    };

    this._state.reviewCycle = reviewCycle;

    const fixMessage = this._buildFixMessage(errors, this._reviewCycleCount);

    logger.info('Self-review: errors detected, injecting fix continuation', {
      errorCount: errors.length,
      cycle: this._reviewCycleCount,
      fingerprint,
    });

    return {
      shouldInjectFix: true,
      fixMessage,
      loopTerminated: false,
      reviewCycle,
    };
  }

  /** Current review cycle count for external inspection */
  getReviewCycleCount(): number {
    return this._reviewCycleCount;
  }

  /** Whether a review loop is actively tracking errors */
  isReviewLoopActive(): boolean {
    return this._reviewCycleCount > 0 && this._reviewCycleCount < MAX_REVIEW_CYCLES;
  }

  /**
   * Check whether any tool in the batch is a file-write tool.
   */
  private _hasFileWriteTools(toolCalls: ReadonlyArray<{ toolName: string }>): boolean {
    return toolCalls.some((tc) => FILE_WRITE_TOOLS.has(tc.toolName));
  }

  /**
   * Programmatically call bolt_get_errors to check the current error state.
   * Returns null if the tool call fails (non-fatal — we just skip the review).
   */
  private async _fetchErrors(): Promise<GetErrorsResult | null> {
    try {
      const { executeAgentTool } = await import('./agentToolsService');
      const result = await executeAgentTool('bolt_get_errors', { source: 'all' });

      if (!result.success || !result.data) {
        logger.debug('Self-review: bolt_get_errors returned no data', { result });
        return null;
      }

      return result.data as GetErrorsResult;
    } catch (error) {
      logger.error('Self-review: failed to fetch errors', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Compute a stable FNV-1a fingerprint of the current error state.
   * Errors are sorted by source + message to ensure deterministic hashing
   * regardless of the order they are reported.
   */
  private _computeErrorFingerprint(errors: ErrorInfo[]): string {
    const normalized = errors
      .map((e) => `${e.source}::${e.message.trim().slice(0, 200)}`)
      .sort()
      .join('\n');

    return fnv1a(normalized);
  }

  /**
   * Check if a fingerprint represents a repeated error state.
   * A state is "repeated" once it appears MAX_IDENTICAL_STATES times
   * in the fingerprint history.
   */
  private _isRepeatedErrorState(fingerprint: string): boolean {
    const occurrences = this._reviewFingerprints.filter((fp) => fp === fingerprint).length;
    return occurrences >= MAX_IDENTICAL_STATES;
  }

  /**
   * Build a continuation message instructing the AI agent to fix detected errors.
   * Includes classified error details and actionable instructions.
   */
  private _buildFixMessage(errors: ErrorInfo[], cycleNumber: number): string {
    const remaining = MAX_REVIEW_CYCLES - cycleNumber;
    const errorLines = errors.map((e) => {
      const category = classifySelfReviewError(e);
      const location = e.file ? ` in \`${e.file}\`` : '';
      const lineInfo = e.line ? `:${e.line}` : '';

      return `- **[${category}]**${location}${lineInfo}: ${e.message}`;
    });

    return [
      `[Self-Review Cycle ${cycleNumber}/${MAX_REVIEW_CYCLES}] I detected **${errors.length}** error(s) after your recent file changes:\n`,
      ...errorLines,
      '',
      '**Instructions:**',
      '1. Carefully analyze each error above',
      '2. Fix the root cause in the relevant files using the appropriate tool (bolt_write_file or bolt_patch_file)',
      '3. After fixing, call `bolt_get_errors` to verify the errors are resolved',
      '',
      remaining > 0
        ? `You have **${remaining}** review cycle(s) remaining. Focus on fixing all errors in this cycle.`
        : '**This is your final review cycle.** Prioritize the most critical errors and leave the project in a stable state.',
    ].join('\n');
  }

  // ─── End Self-Review Loop ───────────────────────────────────────────

  async getAvailableTools(): Promise<string[]> {
    const { getAgentToolNames } = await import('./agentToolsService');
    return getAgentToolNames();
  }

  private _notifyStatusChange(status: AgentStatus): void {
    this._options.onStatusChange?.(status);
  }
}

let singletonInstance: AgentOrchestrator | null = null;

export function getAgentOrchestrator(
  settings?: Partial<AgentModeSettings>,
  options?: Partial<AgentOrchestratorOptions>,
): AgentOrchestrator {
  if (!singletonInstance) {
    singletonInstance = new AgentOrchestrator(settings, options);
  }

  return singletonInstance;
}

export function createAgentOrchestrator(
  settings?: Partial<AgentModeSettings>,
  options?: Partial<AgentOrchestratorOptions>,
): AgentOrchestrator {
  return new AgentOrchestrator(settings, options);
}

export function resetAgentOrchestrator(): void {
  singletonInstance = null;
}

export async function runAgentTask(
  task: string,
  options?: Partial<AgentOrchestratorOptions>,
): Promise<AgentExecutionState> {
  const orchestrator = getAgentOrchestrator({}, options);
  orchestrator.startSession(task);

  return orchestrator.endSession();
}

export async function isAgentModeAvailable(): Promise<boolean> {
  try {
    const { getAgentToolNames } = await import('./agentToolsService');
    return getAgentToolNames().length > 0;
  } catch {
    return false;
  }
}

export function getAgentStatus(): AgentStatus | null {
  if (!singletonInstance) {
    return null;
  }

  return singletonInstance.getState().status;
}
