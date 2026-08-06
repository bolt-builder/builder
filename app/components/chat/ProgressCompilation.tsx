import { AnimatePresence, motion } from 'framer-motion';
import React, { useState } from 'react';
import { useStore } from '@nanostores/react';
import type { ProgressAnnotation } from '~/types/context';
import { cn } from '~/utils/cn';
import { cubicEasingFn } from '~/utils/easings';
import { latestPlanPhaseChange, latestReviewCycle } from '~/lib/stores/stream-event-router';

const PHASE_LABELS: Record<string, string> = {
  idle: 'Idle',
  planning: 'Planning',
  executing: 'Executing',
  reviewing: 'Reviewing',
};

const PHASE_COLORS: Record<string, string> = {
  idle: 'bg-bolt-elements-item-backgroundDefault text-bolt-elements-item-contentDefault',
  planning: 'bg-blue-500/15 text-blue-400',
  executing: 'bg-green-500/15 text-green-400',
  reviewing: 'bg-amber-500/15 text-amber-400',
};

export default function ProgressCompilation({ data }: { data?: ProgressAnnotation[] }) {
  const [progressList, setProgressList] = React.useState<ProgressAnnotation[]>([]);
  const [expanded, setExpanded] = useState(false);
  const planPhaseChange = useStore(latestPlanPhaseChange);
  const reviewCycle = useStore(latestReviewCycle);

  React.useEffect(() => {
    if (!data || data.length === 0) {
      setProgressList([]);
      return;
    }

    const progressMap = new Map<string, ProgressAnnotation>();
    data.forEach((x) => {
      const existingProgress = progressMap.get(x.label);

      if (existingProgress && existingProgress.status === 'complete') {
        return;
      }

      progressMap.set(x.label, x);
    });

    const newData = Array.from(progressMap.values());
    newData.sort((a, b) => a.order - b.order);
    setProgressList(newData);
  }, [data]);

  if (progressList.length === 0 && !planPhaseChange && !reviewCycle) {
    return <></>;
  }

  return (
    <AnimatePresence>
      <div
        className={cn(
          'bg-bolt-elements-background-depth-2',
          'border border-bolt-elements-borderColor',
          'shadow-lg rounded-lg  relative w-full max-w-chat mx-auto z-prompt',
          'p-1',
        )}
      >
        <div
          className={cn(
            'bg-bolt-elements-item-backgroundAccent',
            'p-1 rounded-lg text-bolt-elements-item-contentAccent',
            'flex ',
          )}
        >
          <div className="flex-1">
            <AnimatePresence>
              {planPhaseChange && (
                <PlanPhaseBadge
                  key="plan-phase-badge"
                  fromPhase={planPhaseChange.fromPhase}
                  toPhase={planPhaseChange.toPhase}
                />
              )}
              {reviewCycle && <ReviewCycleIndicator key="review-cycle" cycle={reviewCycle} />}
              {expanded ? (
                <motion.div
                  key="progress-expanded"
                  className="actions"
                  initial={{ height: 0 }}
                  animate={{ height: 'auto' }}
                  exit={{ height: '0px' }}
                  transition={{ duration: 0.15 }}
                >
                  {progressList.map((x, i) => {
                    return <ProgressItem key={`progress-${x.label}-${i}`} progress={x} />;
                  })}
                </motion.div>
              ) : progressList.length > 0 ? (
                <ProgressItem progress={progressList.slice(-1)[0]} />
              ) : null}
            </AnimatePresence>
          </div>
          <motion.button
            initial={{ width: 0 }}
            animate={{ width: 'auto' }}
            exit={{ width: 0 }}
            transition={{ duration: 0.15, ease: cubicEasingFn }}
            className=" p-1 rounded-lg bg-bolt-elements-item-backgroundAccent hover:bg-bolt-elements-artifacts-backgroundHover"
            onClick={() => setExpanded((v) => !v)}
          >
            <div className={expanded ? 'i-ph:caret-up-bold' : 'i-ph:caret-down-bold'}></div>
          </motion.button>
        </div>
      </div>
    </AnimatePresence>
  );
}

const ProgressItem = ({ progress }: { progress: ProgressAnnotation }) => {
  return (
    <motion.div
      className={cn('flex text-sm gap-3')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div className="flex items-center gap-1.5 ">
        <div>
          {progress.status === 'in-progress' ? (
            <div className="i-svg-spinners:90-ring-with-bg"></div>
          ) : progress.status === 'complete' ? (
            <div className="i-ph:check"></div>
          ) : null}
        </div>
        {/* {x.label} */}
      </div>
      {progress.message}
    </motion.div>
  );
};

const PlanPhaseBadge = ({ fromPhase, toPhase }: { fromPhase: string; toPhase: string }) => {
  const label = PHASE_LABELS[toPhase] ?? toPhase;
  const colorClass = PHASE_COLORS[toPhase] ?? PHASE_COLORS.idle;

  return (
    <motion.div
      className={cn('flex text-xs items-center gap-1.5 py-0.5')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div className="i-ph:arrows-clockwise text-bolt-elements-item-contentDefault" />
      <span className="text-bolt-elements-item-contentDefault">{PHASE_LABELS[fromPhase] ?? fromPhase}</span>
      <div className="i-ph:arrow-right text-bolt-elements-item-contentDefault" />
      <span className={cn('px-1.5 py-0.5 rounded-md text-xs font-medium', colorClass)}>{label}</span>
    </motion.div>
  );
};

const ReviewCycleIndicator = ({
  cycle,
}: {
  cycle: { cycleNumber: number; triggeredBy: string; errorsFound: string[]; fixAttempted: boolean };
}) => {
  const errorCount = cycle.errorsFound.length;

  return (
    <motion.div
      className={cn('flex text-xs items-center gap-1.5 py-0.5')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div className="i-ph:magnifying-glass text-bolt-elements-item-contentDefault" />
      <span className="text-bolt-elements-item-contentDefault">Review #{cycle.cycleNumber}</span>
      {errorCount > 0 && (
        <span className="px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-400 font-medium">
          {errorCount} {errorCount === 1 ? 'error' : 'errors'}
        </span>
      )}
      {cycle.fixAttempted && (
        <span className="px-1.5 py-0.5 rounded-md bg-green-500/15 text-green-400 font-medium">fix attempted</span>
      )}
      {errorCount === 0 && (
        <span className="px-1.5 py-0.5 rounded-md bg-green-500/15 text-green-400 font-medium">clean</span>
      )}
    </motion.div>
  );
};
