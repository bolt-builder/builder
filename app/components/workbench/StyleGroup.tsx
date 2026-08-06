/**
 * Collapsible style property group for the Inspector panel.
 *
 * Groups related CSS properties under a labeled section that can be
 * expanded/collapsed. Persists open/closed state in local component state.
 *
 * @module workbench/StyleGroup
 */

import { memo, useState, useCallback } from 'react';

interface StyleGroupProps {
  /** Display label for the group header. */
  label: string;

  /** Icon class (e.g. UnoCSS icon like `i-ph:layout`). */
  icon: string;

  /** Whether the group starts expanded. Defaults to `false`. */
  defaultOpen?: boolean;

  /** Child elements (property controls). */
  children: React.ReactNode;
}

export const StyleGroup = memo(({ label, icon, defaultOpen = false, children }: StyleGroupProps) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  return (
    <div className="border-b border-bolt-elements-borderColor last:border-b-0">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs font-medium bg-transparent text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors"
        aria-expanded={isOpen}
        aria-controls={`style-group-${label}`}
      >
        <div className={`${icon} w-3.5 h-3.5 shrink-0 opacity-60`} aria-hidden="true" />
        <span className="flex-1 text-left">{label}</span>
        <div
          className={`i-ph:caret-right w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div id={`style-group-${label}`} className="px-3 pb-3 pt-1 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
});

StyleGroup.displayName = 'StyleGroup';
