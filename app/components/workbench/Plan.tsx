import React, { memo, useCallback, useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  planStore,
  planProgress,
  subTaskProgress,
  approvePlan,
  rejectPlan,
  modifyPlan,
  type PlanTask,
} from '~/lib/stores/plan';
import { cn } from '~/utils/cn';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '~/components/ui/Collapsible';
import { Button } from '~/components/ui/Button';
import { Progress } from '~/components/ui/Progress';
import type { SubTask, SubTaskStatus } from '~/lib/agent/types';

interface PlanProps {
  className?: string;
}

const taskStatusColors: Record<PlanTask['status'], string> = {
  'not-started': 'text-bolt-elements-textSecondary',
  'in-progress': 'text-blue-500',
  completed: 'text-green-500',
};

const subTaskStatusColors: Record<SubTaskStatus, string> = {
  pending: 'text-bolt-elements-textSecondary',
  'in-progress': 'text-blue-500',
  done: 'text-green-500',
  failed: 'text-red-500',
};

/**
 * Status icon component for task status
 */
const StatusIcon = memo(({ status }: { status: PlanTask['status'] }) => {
  switch (status) {
    case 'completed':
      return (
        <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center">
          <div className="i-ph:check-bold text-green-500 text-sm" />
        </div>
      );
    case 'in-progress':
      return (
        <div className="w-5 h-5 rounded-full bg-blue-500/20 flex items-center justify-center">
          <div className="i-svg-spinners:90-ring-with-bg text-blue-500 text-sm" />
        </div>
      );
    default:
      return <div className="w-5 h-5 rounded-full border-2 border-bolt-elements-borderColor bg-transparent" />;
  }
});

StatusIcon.displayName = 'StatusIcon';

/**
 * Status icon for sub-task statuses (maps SubTaskStatus → visual)
 */
const SubTaskStatusIcon = memo(({ status }: { status: SubTaskStatus }) => {
  switch (status) {
    case 'done':
      return (
        <div className="w-4 h-4 rounded-full bg-green-500/20 flex items-center justify-center">
          <div className="i-ph:check-bold text-green-500 text-xs" />
        </div>
      );
    case 'in-progress':
      return (
        <div className="w-4 h-4 rounded-full bg-blue-500/20 flex items-center justify-center">
          <div className="i-svg-spinners:90-ring-with-bg text-blue-500 text-xs" />
        </div>
      );
    case 'failed':
      return (
        <div className="w-4 h-4 rounded-full bg-red-500/20 flex items-center justify-center">
          <div className="i-ph:x-bold text-red-500 text-xs" />
        </div>
      );
    default:
      return <div className="w-4 h-4 rounded-full border border-bolt-elements-borderColor bg-transparent" />;
  }
});

SubTaskStatusIcon.displayName = 'SubTaskStatusIcon';

/**
 * Review status badge — shows pending/passed/failed on tasks with reviewStatus
 */
const ReviewBadge = memo(({ reviewStatus }: { reviewStatus: NonNullable<PlanTask['reviewStatus']> }) => {
  const config: Record<string, { icon: string; label: string; colors: string }> = {
    pending: {
      icon: 'i-ph:hourglass-medium text-xs',
      label: 'Review Pending',
      colors: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/30',
    },
    passed: {
      icon: 'i-ph:seal-check-fill text-xs',
      label: 'Review Passed',
      colors: 'bg-green-500/15 text-green-500 border-green-500/30',
    },
    failed: {
      icon: 'i-ph:seal-warning-fill text-xs',
      label: 'Review Failed',
      colors: 'bg-red-500/15 text-red-500 border-red-500/30',
    },
  };

  const { icon, label, colors } = config[reviewStatus] ?? config.pending;

  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border', colors)}
      title={label}
    >
      <div className={icon} />
      <span className="sr-only">{label}</span>
    </span>
  );
});

ReviewBadge.displayName = 'ReviewBadge';

/**
 * Dependency indicator chips — shows prerequisite task IDs as small badges
 */
const DependencyChips = memo(({ dependsOn, allTasks }: { dependsOn: string[]; allTasks: PlanTask[] }) => {
  if (dependsOn.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      <div className="i-ph:arrow-bend-down-right text-xs text-bolt-elements-textSecondary" />
      {dependsOn.map((depId, i) => {
        const depTask = allTasks.find((t) => t.id === depId);
        const isDone = depTask?.status === 'completed';

        return (
          <span
            key={`${depId}-${i}`}
            title={depTask ? `Depends on: ${depTask.title}` : `Depends on: ${depId}`}
            className={cn(
              'text-xs px-1.5 py-0.5 rounded-full border font-mono',
              isDone
                ? 'bg-green-500/10 text-green-500/80 border-green-500/20 line-through'
                : 'bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary border-bolt-elements-borderColor',
            )}
          >
            {depId}
          </span>
        );
      })}
    </div>
  );
});

DependencyChips.displayName = 'DependencyChips';

/**
 * Sub-task item — renders a single sub-task row with indentation based on depth (max 2 levels)
 */
const SubTaskItem = memo(({ subTask }: { subTask: SubTask }) => {
  const depthPadding = subTask.depth === 0 ? 'pl-6' : subTask.depth === 1 ? 'pl-10' : 'pl-14';

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className={cn('flex items-center gap-2 py-1.5 px-2 rounded transition-colors', depthPadding)}
    >
      <SubTaskStatusIcon status={subTask.status} />
      <span
        className={cn(
          'text-xs',
          subTask.status === 'done' ? 'line-through opacity-60' : '',
          subTaskStatusColors[subTask.status],
        )}
      >
        {subTask.title}
      </span>
    </motion.div>
  );
});

SubTaskItem.displayName = 'SubTaskItem';

/**
 * Individual task item component — renders task row with sub-tasks, dependency chips,
 * review badges, and sub-task completion percentage.
 */
interface TaskItemProps {
  task: PlanTask;
  index: number;
  allTasks: PlanTask[];
}

const TaskItem = memo(({ task, index, allTasks }: TaskItemProps) => {
  const stProgress = useStore(subTaskProgress);
  const hasSubTasks = task.subTasks != null && task.subTasks.length > 0;
  const hasDeps = task.dependsOn != null && task.dependsOn.length > 0;

  // Default expanded for in-progress, collapsed for completed
  const [subTasksOpen, setSubTasksOpen] = useState(task.status === 'in-progress' || task.status === 'not-started');

  // Track status changes to auto-expand/collapse
  useEffect(() => {
    if (task.status === 'in-progress') {
      setSubTasksOpen(true);
    } else if (task.status === 'completed') {
      setSubTasksOpen(false);
    }
  }, [task.status]);

  const completionPct = hasSubTasks ? (stProgress.get(task.id) ?? 0) : null;

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05 }}
      className={cn(
        'rounded-lg transition-colors',
        task.status === 'in-progress'
          ? 'bg-blue-500/10 border border-blue-500/30'
          : 'bg-bolt-elements-background-depth-2 border border-transparent',
      )}
    >
      {/* Main task row */}
      <div className="flex items-start gap-3 p-3">
        {/* Collapse toggle for tasks with sub-tasks */}
        {hasSubTasks ? (
          <button
            onClick={() => setSubTasksOpen((prev) => !prev)}
            className="mt-0.5 flex-shrink-0 p-0 bg-transparent border-none cursor-pointer"
            aria-label={subTasksOpen ? 'Collapse sub-tasks' : 'Expand sub-tasks'}
          >
            <div
              className={cn(
                'i-ph:caret-right text-sm text-bolt-elements-textSecondary transition-transform',
                subTasksOpen ? 'rotate-90' : '',
              )}
            />
          </button>
        ) : (
          <div className="w-4 flex-shrink-0" />
        )}

        <StatusIcon status={task.status} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'font-medium text-sm',
                task.status === 'completed' ? 'line-through opacity-60' : '',
                taskStatusColors[task.status],
              )}
            >
              {task.title}
            </span>

            {/* Review badge */}
            {task.reviewStatus != null && <ReviewBadge reviewStatus={task.reviewStatus} />}

            {/* Sub-task completion percentage */}
            {completionPct !== null && (
              <span className="text-xs text-bolt-elements-textSecondary ml-auto flex-shrink-0">{completionPct}%</span>
            )}
          </div>

          {task.description && (
            <div className="text-xs text-bolt-elements-textSecondary mt-1 line-clamp-2">{task.description}</div>
          )}

          {/* Dependency chips */}
          {hasDeps && <DependencyChips dependsOn={task.dependsOn!} allTasks={allTasks} />}

          {task.fileActions && task.fileActions.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {task.fileActions.map((file, i) => (
                <span
                  key={`${file}-${i}`}
                  className="text-xs px-1.5 py-0.5 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary font-mono"
                >
                  {file}
                </span>
              ))}
            </div>
          )}

          {/* Sub-task completion bar (only when sub-tasks exist and not 0 or 100) */}
          {completionPct !== null && completionPct > 0 && completionPct < 100 && (
            <div className="mt-2 w-full">
              <Progress value={completionPct} />
            </div>
          )}
        </div>
      </div>

      {/* Collapsible sub-task tree */}
      {hasSubTasks && (
        <AnimatePresence>
          {subTasksOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="border-t border-bolt-elements-borderColor/50 pb-2"
            >
              {task.subTasks!.map((sub, i) => (
                <SubTaskItem key={`${task.id}-${sub.id}-${i}`} subTask={sub} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </motion.div>
  );
});

TaskItem.displayName = 'TaskItem';

/**
 * Plan approval buttons component — drives the two-phase plan workflow.
 * - Approve & Execute: fires planActionAtom('approve') → Chat sends execute message
 * - Modify: opens PLAN.md in editor for the user to edit
 * - Cancel: clears the plan state
 */
const PlanActions = memo(({ approvedByUser, progress }: { approvedByUser: boolean; progress: number }) => {
  const handleApprove = useCallback(() => {
    approvePlan();
  }, []);

  const handleModify = useCallback(() => {
    modifyPlan();
  }, []);

  const handleReject = useCallback(() => {
    rejectPlan();
  }, []);

  // All tasks done — show completion status, no buttons needed
  if (progress >= 100) {
    return (
      <div className="flex items-center gap-2 text-sm text-green-500">
        <div className="i-ph:check-circle-fill" />
        <span>Plan Complete — All tasks done</span>
      </div>
    );
  }

  if (approvedByUser) {
    return (
      <div className="flex items-center gap-2 text-sm text-green-500">
        <div className="i-ph:check-circle-fill" />
        <span>Plan Approved — Executing...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="default"
        size="sm"
        onClick={handleApprove}
        className="bg-green-600 hover:bg-green-700 text-white"
      >
        <div className="i-ph:play-fill mr-1" />
        Approve &amp; Execute
      </Button>
      <Button variant="outline" size="sm" onClick={handleModify}>
        <div className="i-ph:pencil-simple mr-1" />
        Modify
      </Button>
      <Button variant="outline" size="sm" onClick={handleReject}>
        <div className="i-ph:x-bold mr-1" />
        Cancel
      </Button>
    </div>
  );
});

PlanActions.displayName = 'PlanActions';

/**
 * Main Plan component - displays the planning checklist in the workbench
 */
export const Plan = memo(({ className }: PlanProps) => {
  const state = useStore(planStore);
  const progress = useStore(planProgress);

  // Start collapsed if all tasks are already done (e.g. page reload)
  const [isOpen, setIsOpen] = React.useState(progress < 100);

  // Auto-collapse the plan panel after all tasks complete
  useEffect(() => {
    if (progress >= 100) {
      const timer = setTimeout(() => setIsOpen(false), 3000);
      return () => clearTimeout(timer);
    }

    return undefined;
  }, [progress]);

  if (!state.isActive || state.tasks.length === 0) {
    return null;
  }

  const completedCount = state.tasks.filter((t) => t.status === 'completed').length;
  const totalCount = state.tasks.length;

  return (
    <div className={cn('border-b border-bolt-elements-borderColor', className)}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <button
            className={cn(
              'w-full flex items-center justify-between p-4',
              'bg-bolt-elements-background-depth-1 hover:bg-bolt-elements-background-depth-2',
              'transition-colors cursor-pointer',
            )}
          >
            <div className="flex items-center gap-3">
              <div className="i-ph:list-checks-fill text-xl text-bolt-elements-textPrimary" />
              <div className="text-left">
                <h3 className="font-semibold text-bolt-elements-textPrimary">
                  {state.planTitle || 'Implementation Plan'}
                </h3>
                <p className="text-xs text-bolt-elements-textSecondary">
                  {completedCount} of {totalCount} tasks completed
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              {/* Progress indicator */}
              <div className="flex items-center gap-2">
                <div className="w-24 hidden sm:block">
                  <Progress value={progress} />
                </div>
                <span className="text-sm font-medium text-bolt-elements-textSecondary">{progress}%</span>
              </div>

              {/* Chevron */}
              <div
                className={cn(
                  'i-ph:caret-down text-bolt-elements-textSecondary transition-transform',
                  isOpen ? 'rotate-180' : '',
                )}
              />
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <AnimatePresence>
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="p-4 pt-0 space-y-3"
            >
              {/* Task list */}
              <div className="space-y-2">
                {state.tasks.map((task, index) => (
                  <TaskItem key={task.id} task={task} index={index} allTasks={state.tasks} />
                ))}
              </div>

              {/* Approval actions */}
              <div className="pt-3 border-t border-bolt-elements-borderColor">
                <PlanActions approvedByUser={state.approvedByUser} progress={progress} />
              </div>
            </motion.div>
          </AnimatePresence>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});

Plan.displayName = 'Plan';
