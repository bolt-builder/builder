import { useState, useRef, useCallback, type PropsWithChildren } from 'react';

const ThoughtBox = ({ title, children }: PropsWithChildren<{ title: string }>) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => {
      if (prev && contentRef.current) {
        contentRef.current.scrollTop = 0;
      }

      return !prev;
    });
  }, []);

  return (
    <div className="bg-bolt-elements-background-depth-2 shadow-sm rounded-lg border border-bolt-elements-borderColor">
      {/* Header — always visible, never scrolls away */}
      <div
        onClick={handleToggle}
        className="px-3 py-2 flex items-center gap-2 rounded-lg text-bolt-elements-textSecondary font-medium text-xs cursor-pointer select-none"
      >
        <div className="i-ph:brain-thin text-lg flex-shrink-0" />
        <span>{title}</span>
      </div>

      {/* Content — scrollable when expanded, fully hidden when collapsed */}
      <div
        ref={contentRef}
        className={`
          transition-all duration-300
          ${isExpanded ? 'max-h-80 overflow-y-auto opacity-100 px-3 pb-3' : 'max-h-0 overflow-hidden opacity-0'}
        `}
      >
        {children}
      </div>
    </div>
  );
};

export default ThoughtBox;
