import { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react';
import type { BulkTarget } from '~/lib/inspector/types';

interface BulkStyleSelectorProps {
  currentTagName: string;
  selectedTarget: BulkTarget | null;
  onSelectTarget: (target: BulkTarget | null) => void;
  affectedCount?: number;
}

const ELEMENT_CATEGORIES: { category: string; targets: Omit<BulkTarget, 'selector'>[] }[] = [
  {
    category: 'Single Element',
    targets: [{ value: 'current', label: 'Current Element Only' }],
  },
  {
    category: 'Headings',
    targets: [
      { value: 'all-headings', label: 'All Headings (H1-H6)' },
      { value: 'h1', label: 'All H1' },
      { value: 'h2', label: 'All H2' },
      { value: 'h3', label: 'All H3' },
      { value: 'h4', label: 'All H4' },
    ],
  },
  {
    category: 'Text',
    targets: [
      { value: 'all-text', label: 'All Text Elements' },
      { value: 'p', label: 'All Paragraphs' },
      { value: 'a', label: 'All Links' },
      { value: 'span', label: 'All Spans' },
      { value: 'label', label: 'All Labels' },
    ],
  },
  {
    category: 'Containers',
    targets: [
      { value: 'all-boxes', label: 'All Containers' },
      { value: 'div', label: 'All Divs' },
      { value: 'section', label: 'All Sections' },
      { value: 'article', label: 'All Articles' },
      { value: 'aside', label: 'All Asides' },
    ],
  },
  {
    category: 'Lists',
    targets: [
      { value: 'all-lists', label: 'All Lists' },
      { value: 'li', label: 'All List Items' },
    ],
  },
];

// Map values to CSS selectors
const VALUE_TO_SELECTOR: Record<string, string> = {
  current: '',
  'all-headings': 'h1, h2, h3, h4, h5, h6',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  'all-text': 'p, span, a, label, li, td, th',
  p: 'p',
  a: 'a',
  span: 'span',
  label: 'label',
  'all-boxes': 'div, section, article, aside, main, header, footer, nav',
  div: 'div',
  section: 'section',
  article: 'article',
  aside: 'aside',
  'all-lists': 'ul, ol',
  li: 'li',
};

export const BulkStyleSelector = memo(
  ({ currentTagName, selectedTarget, onSelectTarget, affectedCount }: BulkStyleSelectorProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const [focusedIndex, setFocusedIndex] = useState(-1);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    /* ── Flat options list for keyboard navigation ───────────────── */

    const flatOptions = useMemo(() => {
      const options: { value: string; label: string }[] = [];

      for (const category of ELEMENT_CATEGORIES) {
        for (const target of category.targets) {
          options.push({ value: target.value, label: target.label });
        }
      }

      if (currentTagName && !['html', 'body', 'head'].includes(currentTagName.toLowerCase())) {
        options.push({ value: 'same-tag', label: `All <${currentTagName}>` });
      }

      return options;
    }, [currentTagName]);

    /* ── Close on outside click ──────────────────────────────────── */

    useEffect(() => {
      if (!isOpen) {
        return undefined;
      }

      const handleMouseDown = (e: MouseEvent) => {
        if (
          dropdownRef.current &&
          !dropdownRef.current.contains(e.target as Node) &&
          buttonRef.current &&
          !buttonRef.current.contains(e.target as Node)
        ) {
          setIsOpen(false);
          setFocusedIndex(-1);
        }
      };

      document.addEventListener('mousedown', handleMouseDown);

      return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [isOpen]);

    /* ── Reset focused index when dropdown opens ─────────────────── */

    useEffect(() => {
      if (isOpen) {
        const currentValue = selectedTarget?.value ?? 'current';
        const idx = flatOptions.findIndex((o) => o.value === currentValue);
        setFocusedIndex(idx >= 0 ? idx : 0);
      }
    }, [isOpen, selectedTarget, flatOptions]);

    /* ── Scroll focused option into view ─────────────────────────── */

    useEffect(() => {
      if (isOpen && focusedIndex >= 0 && focusedIndex < flatOptions.length) {
        const el = document.getElementById(`bulk-option-${flatOptions[focusedIndex].value}`);
        el?.scrollIntoView({ block: 'nearest' });
      }
    }, [isOpen, focusedIndex, flatOptions]);

    const handleSelect = useCallback(
      (value: string, label: string) => {
        if (value === 'current') {
          onSelectTarget(null);
        } else if (value === 'same-tag') {
          onSelectTarget({
            value: 'same-tag',
            label: `All <${currentTagName}>`,
            selector: currentTagName.toLowerCase(),
          });
        } else {
          onSelectTarget({
            value,
            label,
            selector: VALUE_TO_SELECTOR[value] || value,
          });
        }

        setIsOpen(false);
        setFocusedIndex(-1);
      },
      [currentTagName, onSelectTarget],
    );

    /* ── Keyboard navigation ─────────────────────────────────────── */

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (!isOpen) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsOpen(true);
          }

          return;
        }

        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setFocusedIndex((prev) => (prev + 1) % flatOptions.length);
            break;
          case 'ArrowUp':
            e.preventDefault();
            setFocusedIndex((prev) => (prev - 1 + flatOptions.length) % flatOptions.length);
            break;
          case 'Home':
            e.preventDefault();
            setFocusedIndex(0);
            break;
          case 'End':
            e.preventDefault();
            setFocusedIndex(flatOptions.length - 1);
            break;
          case 'Enter':
          case ' ':
            e.preventDefault();

            if (focusedIndex >= 0 && focusedIndex < flatOptions.length) {
              const option = flatOptions[focusedIndex];
              handleSelect(option.value, option.label);
            }

            break;
          case 'Escape':
            e.preventDefault();
            setIsOpen(false);
            setFocusedIndex(-1);
            buttonRef.current?.focus();
            break;
          default:
            break;
        }
      },
      [isOpen, flatOptions, focusedIndex, handleSelect],
    );

    const displayLabel = selectedTarget ? selectedTarget.label : 'Current Element Only';
    const isBulkMode = selectedTarget !== null;

    return (
      <div className="relative">
        <style>{`
          @keyframes bulkDropdownIn {
            from { opacity: 0; transform: translateY(-4px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>

        {/* Toggle Button */}
        <button
          ref={buttonRef}
          onClick={() => setIsOpen(!isOpen)}
          onKeyDown={handleKeyDown}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-activedescendant={
            isOpen && focusedIndex >= 0 && focusedIndex < flatOptions.length
              ? `bulk-option-${flatOptions[focusedIndex].value}`
              : undefined
          }
          className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 text-xs font-medium rounded border transition-colors ${
            isBulkMode
              ? 'bg-purple-500/20 border-purple-500/50 text-purple-300 hover:bg-purple-500/30'
              : 'bg-bolt-elements-background-depth-3 border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-4'
          }`}
        >
          <div className="flex items-center gap-1.5">
            <span className={isBulkMode ? 'i-ph:stack-bold' : 'i-ph:cursor-click'} />
            <span className="truncate">{displayLabel}</span>
          </div>
          <div className="flex items-center gap-1">
            {isBulkMode && affectedCount !== undefined && (
              <span className="text-[10px] bg-purple-500/30 px-1.5 py-0.5 rounded-full">{affectedCount} elements</span>
            )}
            <span className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}>
              <span className="i-ph:caret-down w-3 h-3" />
            </span>
          </div>
        </button>

        {/* Dropdown */}
        {isOpen && (
          <div
            ref={dropdownRef}
            role="listbox"
            aria-label="Bulk style target"
            className="absolute top-full left-0 right-0 mt-1 bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto"
            style={{ animation: 'bulkDropdownIn 150ms ease-out' }}
          >
            {ELEMENT_CATEGORIES.map((category) => (
              <div key={category.category}>
                <div className="px-2 py-1 text-[10px] font-semibold text-bolt-elements-textTertiary uppercase bg-bolt-elements-background-depth-3 sticky top-0">
                  {category.category}
                </div>
                {category.targets.map((target) => {
                  const isSelected =
                    selectedTarget?.value === target.value || (target.value === 'current' && !selectedTarget);
                  const isFocused =
                    focusedIndex >= 0 &&
                    focusedIndex < flatOptions.length &&
                    flatOptions[focusedIndex].value === target.value;

                  return (
                    <button
                      key={target.value}
                      id={`bulk-option-${target.value}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => handleSelect(target.value, target.label)}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bolt-elements-background-depth-3 transition-colors ${isSelected ? 'bg-accent-500/20 text-accent-400' : 'text-bolt-elements-textPrimary'} ${isFocused ? 'outline outline-1 outline-accent-400 bg-bolt-elements-background-depth-3' : ''}`}
                    >
                      {target.label}
                    </button>
                  );
                })}
              </div>
            ))}

            {/* Dynamic "Same Tag" Option */}
            {currentTagName && !['html', 'body', 'head'].includes(currentTagName.toLowerCase()) && (
              <div>
                <div className="px-2 py-1 text-[10px] font-semibold text-bolt-elements-textTertiary uppercase bg-bolt-elements-background-depth-3 sticky top-0">
                  Same Type
                </div>
                <button
                  id="bulk-option-same-tag"
                  role="option"
                  aria-selected={selectedTarget?.value === 'same-tag'}
                  onClick={() => handleSelect('same-tag', `All <${currentTagName}>`)}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bolt-elements-background-depth-3 transition-colors ${
                    selectedTarget?.value === 'same-tag'
                      ? 'bg-accent-500/20 text-accent-400'
                      : 'text-bolt-elements-textPrimary'
                  } ${
                    focusedIndex >= 0 &&
                    focusedIndex < flatOptions.length &&
                    flatOptions[focusedIndex].value === 'same-tag'
                      ? 'outline outline-1 outline-accent-400 bg-bolt-elements-background-depth-3'
                      : ''
                  }`}
                >
                  All &lt;{currentTagName.toLowerCase()}&gt; elements
                </button>
              </div>
            )}
          </div>
        )}

        {/* Bulk Mode Indicator */}
        {isBulkMode && (
          <div className="mt-1 text-[10px] text-purple-400 flex items-center gap-1">
            <span className="i-ph:warning-circle w-3 h-3" />
            Changes will apply to all matching elements
          </div>
        )}
      </div>
    );
  },
);

BulkStyleSelector.displayName = 'BulkStyleSelector';
