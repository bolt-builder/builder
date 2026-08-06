import { memo, useCallback } from 'react';

interface ElementSummary {
  tagName: string;
  id: string;
  classes: string[];
  selector: string;
  displayText: string;
  hasChildren: boolean;
}

interface ElementHierarchy {
  parents: ElementSummary[];
  current: ElementSummary | null;
  children: ElementSummary[];
  siblings: ElementSummary[];
  totalChildren: number;
  totalSiblings: number;
}

interface ElementTreeNavigatorProps {
  hierarchy: ElementHierarchy | null;
  onSelectElement?: (selector: string) => void;
}

const TreeNode = memo(
  ({
    element,
    isActive = false,
    indent = 0,
    onClick,
    icon,
  }: {
    element: ElementSummary;
    isActive?: boolean;
    indent?: number;
    onClick?: () => void;
    icon?: string;
  }) => {
    return (
      <button
        onClick={onClick}
        className={`w-full text-left px-2 py-1.5 text-xs font-mono rounded transition-all flex items-center gap-1.5 ${
          isActive
            ? 'bg-accent-500/20 text-accent-400 border border-accent-500/30'
            : 'hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary'
        }`}
        style={{ paddingLeft: `${indent * 12 + 8}px` }}
        title={element.selector}
      >
        {icon && <span className={`${icon} w-3 h-3 opacity-60`} />}
        <span className="text-blue-400">{element.tagName}</span>
        {element.id && <span className="text-green-400">#{element.id}</span>}
        {element.classes.length > 0 && !element.id && (
          <span className="text-yellow-400 truncate">.{element.classes[0]}</span>
        )}
        {element.hasChildren && <span className="text-bolt-elements-textTertiary ml-auto">›</span>}
      </button>
    );
  },
);

TreeNode.displayName = 'TreeNode';

export const ElementTreeNavigator = memo(({ hierarchy, onSelectElement }: ElementTreeNavigatorProps) => {
  const handleSelect = useCallback(
    (selector: string) => {
      onSelectElement?.(selector);
    },
    [onSelectElement],
  );

  if (!hierarchy || !hierarchy.current) {
    return (
      <div className="text-center py-8 text-bolt-elements-textTertiary text-xs">
        <div className="i-ph:tree-structure w-8 h-8 mx-auto mb-2 opacity-40" />
        <p>Select an element to view its tree</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Parent Chain */}
      {hierarchy.parents.length > 0 && (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-[10px] text-bolt-elements-textTertiary uppercase tracking-wide mb-1">
            <span className="i-ph:arrow-up w-3 h-3" />
            Parents
          </div>
          <div className="border-l-2 border-bolt-elements-borderColor ml-1.5 pl-1">
            {hierarchy.parents.map((parent, index) => (
              <TreeNode
                key={`parent-${index}`}
                element={parent}
                indent={index}
                onClick={() => handleSelect(parent.selector)}
                icon="i-ph:folder-simple"
              />
            ))}
          </div>
        </div>
      )}

      {/* Current Element */}
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5 text-[10px] text-accent-400 uppercase tracking-wide mb-1">
          <span className="i-ph:cursor-click w-3 h-3" />
          Selected
        </div>
        <TreeNode element={hierarchy.current} isActive indent={hierarchy.parents.length} icon="i-ph:crosshair" />
      </div>

      {/* Children */}
      {hierarchy.children.length > 0 && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-bolt-elements-textTertiary uppercase tracking-wide mb-1">
              <span className="i-ph:arrow-down w-3 h-3" />
              Children
            </div>
            {hierarchy.totalChildren > hierarchy.children.length && (
              <span className="text-[10px] text-bolt-elements-textTertiary">
                +{hierarchy.totalChildren - hierarchy.children.length} more
              </span>
            )}
          </div>
          <div className="border-l-2 border-accent-500/30 ml-1.5 pl-1">
            {hierarchy.children.map((child, index) => (
              <TreeNode
                key={`child-${index}`}
                element={child}
                indent={0}
                onClick={() => handleSelect(child.selector)}
                icon="i-ph:file"
              />
            ))}
          </div>
        </div>
      )}

      {/* Siblings */}
      {hierarchy.siblings.length > 0 && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-bolt-elements-textTertiary uppercase tracking-wide mb-1">
              <span className="i-ph:arrows-horizontal w-3 h-3" />
              Siblings
            </div>
            {hierarchy.totalSiblings > hierarchy.siblings.length && (
              <span className="text-[10px] text-bolt-elements-textTertiary">
                +{hierarchy.totalSiblings - hierarchy.siblings.length} more
              </span>
            )}
          </div>
          <div className="border-l-2 border-bolt-elements-borderColor ml-1.5 pl-1 opacity-75">
            {hierarchy.siblings.slice(0, 5).map((sibling, index) => (
              <TreeNode
                key={`sibling-${index}`}
                element={sibling}
                indent={0}
                onClick={() => handleSelect(sibling.selector)}
                icon="i-ph:file-dashed"
              />
            ))}
          </div>
        </div>
      )}

      {/* Quick Navigation Hint */}
      <div className="pt-2 border-t border-bolt-elements-borderColor">
        <p className="text-[10px] text-bolt-elements-textTertiary text-center">
          Click any element to navigate and inspect it
        </p>
      </div>
    </div>
  );
});

ElementTreeNavigator.displayName = 'ElementTreeNavigator';
