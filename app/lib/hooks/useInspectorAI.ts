/**
 * Sub-hook: AI prompt construction and dispatch for the Element Inspector.
 *
 * Builds human-readable prompts from pending style/text edits (single
 * or bulk) and forwards them to the consumer's `onAIAction` callback.
 *
 * When agent mode is active and the orchestrator has an active session,
 * routes edits through the agent tool pipeline (`devonz_write_file`)
 * instead of dispatching as plain chat messages. This ensures inspector
 * edits appear in the agent's tool call history and go through the
 * approval flow.
 *
 * @module hooks/useInspectorAI
 */

import { useCallback } from 'react';

import {
  selectedElementAtom,
  pendingEditsAtom,
  pendingTextEditAtom,
  inspectorPanelVisibleAtom,
  accumulatedBulkChangesAtom,
  clearAllBulkChanges,
} from '~/lib/stores/inspector';

import { isAgentModeEnabled } from '~/lib/stores/agentMode';
import { getAgentOrchestrator } from '~/lib/services/agentOrchestratorService';
import { enrichWithSourceContext } from '~/lib/inspector/source-context';
import { createScopedLogger } from '~/utils/logger';
import { sanitizeCSSValue } from '~/utils/sanitize';
import { buildElementSelector } from '~/utils/selector';

const logger = createScopedLogger('InspectorAI');

// ─── Return Interface ──────────────────────────────────────────────────────

/** Actions exposed by the AI sub-hook. */
export interface UseInspectorAIReturn {
  /** Build a prompt from pending single-element edits and dispatch it. */
  applyWithAI: () => void;

  /**
   * Build a CSS stylesheet from accumulated bulk changes, dispatch it,
   * and clear the bulk state.
   */
  applyBulkCSS: () => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Check whether the agent tool pipeline is available for routing.
 * Returns `true` when agent mode is enabled AND the orchestrator
 * session can continue (i.e. is active and within iteration limits).
 */
function isAgentPipelineAvailable(): boolean {
  if (!isAgentModeEnabled()) {
    return false;
  }

  try {
    const orchestrator = getAgentOrchestrator();
    return orchestrator.canContinue();
  } catch {
    return false;
  }
}

/**
 * Route a CSS file write through the agent orchestrator's tool pipeline.
 * The orchestrator handles approval flow and records the tool call in
 * its history automatically.
 *
 * @returns `true` if the tool call succeeded, `false` otherwise.
 */
async function routeThroughAgentPipeline(filePath: string, content: string): Promise<boolean> {
  try {
    const orchestrator = getAgentOrchestrator();
    const result = await orchestrator.executeTool('devonz_write_file', {
      path: filePath,
      content,
    });

    if (!result.success) {
      logger.warn('Agent pipeline write rejected or failed', { filePath, error: result.error });
    }

    return result.success;
  } catch (error) {
    logger.error('Agent pipeline routing failed', error);
    return false;
  }
}

// ─── Hook ──────────────────────────────────────────────────────────────────

/**
 * Provides AI-related actions for the Element Inspector.
 *
 * Both actions read directly from nanostore atoms, construct a
 * descriptive prompt, and pass it to the `onAIAction` callback.
 *
 * When agent mode is active and the orchestrator session is running,
 * edits are routed through the agent tool pipeline via
 * `devonz_write_file`. The orchestrator handles approval flow and
 * records each edit in the tool call history. If the pipeline is
 * unavailable or the write fails, the hook falls back to the plain
 * `onAIAction` dispatch.
 *
 * @param onAIAction - Callback that receives the generated AI prompt.
 * @returns `applyWithAI` and `applyBulkCSS` action functions.
 */
export function useInspectorAI(onAIAction: ((message: string) => void) | undefined): UseInspectorAIReturn {
  /**
   * Build an AI prompt describing the pending changes and forward it
   * through the agent tool pipeline (when active) or to the consumer
   * via `onAIAction`.
   */
  const applyWithAI = useCallback(() => {
    const element = selectedElementAtom.get();
    const edits = pendingEditsAtom.get();
    const textEdit = pendingTextEditAtom.get();

    if (!element) {
      return;
    }

    // Build a human-readable selector (sanitised)
    const selector = buildElementSelector(element);

    const styleEntries = Object.entries(edits);

    // ── Agent mode: route through tool pipeline ────────────────────────
    if (isAgentPipelineAvailable() && (styleEntries.length > 0 || textEdit)) {
      const cssLines = styleEntries.map(([prop, value]) => `  ${prop}: ${sanitizeCSSValue(value as string)};`);

      const sections: string[] = [`/* Inspector Override — Element: ${selector} */`];

      if (textEdit) {
        sections.push(`/* Text content change: "${textEdit}" */`);
      }

      if (cssLines.length > 0) {
        sections.push(`${selector} {\n${cssLines.join('\n')}\n}`);
      }

      const cssContent = sections.join('\n');

      // Fire-and-forget with graceful fallback to onAIAction
      void routeThroughAgentPipeline('app/styles/inspector-overrides.css', cssContent).then(async (success) => {
        if (!success) {
          // Fallback: dispatch the original prompt so the user isn't stuck
          const fallbackMessage = buildApplyWithAIMessage(selector, styleEntries, textEdit);
          onAIAction?.(await enrichWithSourceContext(fallbackMessage, element));
        }
      });

      // Close panel immediately — the pipeline handles the rest
      inspectorPanelVisibleAtom.set(false);
      selectedElementAtom.set(null);

      return;
    }

    // ── Existing behaviour: dispatch as plain chat message ─────────────
    const message = buildApplyWithAIMessage(selector, styleEntries, textEdit);
    void enrichWithSourceContext(message, element).then((enriched) => onAIAction?.(enriched));

    // Close panel after dispatching
    inspectorPanelVisibleAtom.set(false);
    selectedElementAtom.set(null);
  }, [onAIAction]);

  /**
   * Generate a full CSS stylesheet from accumulated bulk changes and
   * route it through the agent tool pipeline (when active) or forward
   * it to the AI via `onAIAction`.
   */
  const applyBulkCSS = useCallback(() => {
    const changes = accumulatedBulkChangesAtom.get();

    if (changes.length === 0) {
      return;
    }

    // Group changes by selector for cleaner CSS output
    const grouped: Record<string, Record<string, string>> = {};

    for (const { selector, property, value } of changes) {
      grouped[selector] ??= {};
      grouped[selector][property] = value;
    }

    const cssRules = Object.entries(grouped)
      .map(([sel, styles]) => {
        const styleLines = Object.entries(styles)
          .map(([prop, val]) => `  ${prop}: ${val} !important;`)
          .join('\n');

        return `${sel} {\n${styleLines}\n}`;
      })
      .join('\n\n');

    const fullCSS = `/* Bulk Style Changes — Applied via Inspector */\n${cssRules}`;

    // ── Agent mode: route through tool pipeline ────────────────────────
    if (isAgentPipelineAvailable()) {
      // Fire-and-forget with graceful fallback to onAIAction
      void routeThroughAgentPipeline('app/styles/inspector-overrides.css', fullCSS).then((success) => {
        if (!success) {
          // Fallback: dispatch the original prompt so the user isn't stuck
          const fallbackMessage = buildBulkCSSMessage(fullCSS);
          onAIAction?.(fallbackMessage);
        }
      });

      // Clear accumulated bulk state after dispatch
      clearAllBulkChanges();
      inspectorPanelVisibleAtom.set(false);
      selectedElementAtom.set(null);

      return;
    }

    // ── Existing behaviour: dispatch as plain chat message ─────────────
    const message = buildBulkCSSMessage(fullCSS);
    onAIAction?.(message);

    // Clear accumulated bulk state after dispatch
    clearAllBulkChanges();
    inspectorPanelVisibleAtom.set(false);
    selectedElementAtom.set(null);
  }, [onAIAction]);

  return { applyWithAI, applyBulkCSS };
}

// ─── Message Builders ──────────────────────────────────────────────────────

/**
 * Build the plain-text prompt for single-element changes (used as
 * fallback when agent pipeline is unavailable or fails).
 */
function buildApplyWithAIMessage(selector: string, styleEntries: [string, unknown][], textEdit: string | null): string {
  const changeLines: string[] = [];

  if (styleEntries.length > 0) {
    changeLines.push('**Style changes:**');
    styleEntries.forEach(([prop, value]) => {
      changeLines.push(`- ${prop}: ${sanitizeCSSValue(value as string)}`);
    });
  }

  if (textEdit) {
    changeLines.push(`**Text content:** "${textEdit}"`);
  }

  return `Please apply these changes to the element \`${selector}\`:\n\n${changeLines.join('\n')}\n\nFind this element in the source code and update its styles/text accordingly.`;
}

/**
 * Build the plain-text prompt for bulk CSS changes (used as fallback
 * when agent pipeline is unavailable or fails).
 */
function buildBulkCSSMessage(fullCSS: string): string {
  return `Please add the following CSS rules to the project's main stylesheet (or create a new style block if needed):\n\n\`\`\`css\n${fullCSS}\n\`\`\`\n\nAdd these rules to style the elements as specified. The !important flags ensure these styles take precedence.`;
}
