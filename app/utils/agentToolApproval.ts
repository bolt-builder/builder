/**
 * Shared utility for determining which agent tools should be auto-approved.
 * Used by both Chat.client.tsx (onToolCall) and ToolInvocations.tsx (fallback UI).
 */

/** Read-only agent tools that never require approval */
export const AGENT_READ_ONLY_TOOLS = new Set([
  'bolt_read_file',
  'bolt_list_directory',
  'bolt_get_errors',
  'bolt_search_code',
]);

/** Agent tools that perform file operations */
export const AGENT_FILE_TOOLS = new Set(['bolt_write_file', 'bolt_delete_file', 'bolt_rename_file', 'bolt_patch_file']);

/** Agent tools that manage agent state (plan, memory) */
export const AGENT_STATE_TOOLS = new Set(['bolt_update_plan', 'bolt_save_memory']);

/** Agent tools that run commands */
export const AGENT_COMMAND_TOOLS = new Set(['bolt_run_command']);

export interface AgentApprovalSettings {
  autoApproveFileCreation: boolean;
  autoApproveFileModification: boolean;
  autoApproveCommands: boolean;
}

/**
 * Check if an agent tool should be auto-approved based on agent mode settings.
 * Returns true if the tool should be auto-approved, false if it requires user approval.
 */
export function shouldAutoApproveAgentTool(toolName: string, settings: AgentApprovalSettings): boolean {
  if (AGENT_READ_ONLY_TOOLS.has(toolName)) {
    return true;
  }

  if (AGENT_FILE_TOOLS.has(toolName)) {
    return settings.autoApproveFileCreation && settings.autoApproveFileModification;
  }

  if (AGENT_COMMAND_TOOLS.has(toolName)) {
    return settings.autoApproveCommands;
  }

  if (AGENT_STATE_TOOLS.has(toolName)) {
    return settings.autoApproveFileModification;
  }

  return false;
}
