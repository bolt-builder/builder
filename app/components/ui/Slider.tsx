import { motion } from 'framer-motion';
import { memo } from 'react';
import { cubicEasingFn } from '~/utils/easings';
import { genericMemo } from '~/utils/react';

export interface SliderOption<T> {
  value: T;
  text: string;
  icon?: string;
}

export type SliderOptions<T> = {
  left: SliderOption<T>;
  middle?: SliderOption<T>;
  right: SliderOption<T>;
};

interface SliderProps<T> {
  selected: T;
  options: SliderOptions<T>;
  setSelected?: (selected: T) => void;
}

export const Slider = genericMemo(<T,>({ selected, options, setSelected }: SliderProps<T>) => {
  const entries: Array<SliderOption<T>> = [options.left, ...(options.middle ? [options.middle] : []), options.right];

  return (
    <div className="flex items-center shrink-0 gap-1 bg-devonz-elements-background-depth-1 border border-devonz-elements-borderColor overflow-hidden rounded-xl p-1">
      {entries.map((option) => (
        <SliderButton
          key={option.text}
          selected={selected === option.value}
          icon={option.icon}
          setSelected={() => setSelected?.(option.value)}
        >
          {option.text}
        </SliderButton>
      ))}
    </div>
  );
});

interface SliderButtonProps {
  selected: boolean;
  children: string | JSX.Element | Array<JSX.Element | string>;
  icon?: string;
  setSelected: () => void;
}

const SliderButton = memo(({ selected, children, icon, setSelected }: SliderButtonProps) => {
  return (
    <button
      onClick={setSelected}
      className={
        'bg-transparent text-[13px] font-medium h-8 px-3.5 rounded-lg relative flex items-center gap-2 transition-colors ' +
        (selected
          ? 'text-devonz-elements-textPrimary'
          : 'text-devonz-elements-textTertiary hover:text-devonz-elements-textSecondary')
      }
    >
      {icon && <span className={`${icon} text-base relative z-10 ${selected ? 'text-accent-500' : ''}`} />}
      <span className="relative z-10">{children}</span>
      {selected && (
        <motion.span
          layoutId="workbench-view-tab"
          transition={{ duration: 0.2, ease: cubicEasingFn }}
          className="absolute inset-0 z-0 rounded-lg bg-devonz-elements-background-depth-3 border border-devonz-elements-borderColor shadow-sm"
        ></motion.span>
      )}
    </button>
  );
});
