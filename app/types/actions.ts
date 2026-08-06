import type { Change } from 'diff';

export type ActionType = 'file' | 'diff' | 'shell' | 'supabase' | 'plan' | 'task-update';

export interface BaseAction {
  content: string;
}

export interface FileAction extends BaseAction {
  type: 'file';
  filePath: string;
}

/**
 * A single search-replace block used by the diff-based editing mode.
 * The parser locates `search` within the target file and replaces it
 * with `replace`. Used by both the dual-mode message parser and the
 * action runner.
 */
export interface SearchReplaceBlock {
  search: string;
  replace: string;
}

/**
 * Diff action — applies one or more search-replace blocks to a file
 * instead of replacing its entire content.
 */
export interface DiffAction extends BaseAction {
  type: 'diff';
  filePath: string;
  diffBlocks: SearchReplaceBlock[];
}

export interface ShellAction extends BaseAction {
  type: 'shell';
}

export interface StartAction extends BaseAction {
  type: 'start';
}

export interface BuildAction extends BaseAction {
  type: 'build';
}

export interface SupabaseAction extends BaseAction {
  type: 'supabase';
  operation: 'migration' | 'query';
  filePath?: string;
  projectId?: string;
}

/**
 * Plan action - creates a structured task list before code execution
 */
export interface PlanAction extends BaseAction {
  type: 'plan';

  /** Title of the plan */
  planTitle?: string;
}

/**
 * Task data within a plan
 */
export interface PlanTaskData {
  id: string;
  title: string;
  description?: string;
  fileActions?: string[];
}

/**
 * Task update action - updates the status of a task in the plan
 */
export interface TaskUpdateAction extends BaseAction {
  type: 'task-update';
  taskId: string;
  taskStatus: 'not-started' | 'in-progress' | 'completed';
}

export type BoltAction =
  FileAction | DiffAction | ShellAction | StartAction | BuildAction | SupabaseAction | PlanAction | TaskUpdateAction;

export type BoltActionData = BoltAction | BaseAction;

export interface ActionAlert {
  type: string;
  title: string;
  description: string;
  content?: string;
  source?: 'terminal' | 'preview'; // Add source to differentiate between terminal and preview errors
}

export interface SupabaseAlert {
  type: string;
  title: string;
  description: string;
  content?: string;
  source?: 'supabase';
}

export interface DeployAlert {
  type: 'success' | 'error' | 'info';
  title: string;
  description: string;
  content?: string;
  url?: string;
  stage?: 'building' | 'deploying' | 'complete';
  buildStatus?: 'pending' | 'running' | 'complete' | 'failed';
  deployStatus?: 'pending' | 'running' | 'complete' | 'failed';
  source?: 'vercel' | 'netlify' | 'github' | 'gitlab';
}

export interface LlmErrorAlertType {
  type: 'error' | 'warning';
  title: string;
  description: string;
  content?: string;
  provider?: string;
  errorType?: 'authentication' | 'rate_limit' | 'quota' | 'network' | 'unknown';
}

export interface FileHistory {
  originalContent: string;
  lastModified: number;
  changes: Change[];
  versions: {
    timestamp: number;
    content: string;
  }[];

  // Novo campo para rastrear a origem das mudanças
  changeSource?: 'user' | 'auto-save' | 'external';
}
