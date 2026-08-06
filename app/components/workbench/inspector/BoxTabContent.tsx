/**
 * Box tab content for the Inspector panel.
 *
 * Renders the element tree navigator and box-model editor.
 * Extracted from InspectorPanel for better maintainability.
 *
 * @module workbench/inspector/BoxTabContent
 */

import { memo } from 'react';
import type { ElementInfo } from '~/lib/inspector/types';
import { BoxModelEditor } from '~/components/workbench/BoxModelEditor';
import { ElementTreeNavigator } from '~/components/workbench/ElementTreeNavigator';

/* ─── Props ────────────────────────────────────────────────────────── */

export interface BoxTabContentProps {
  selectedElement: ElementInfo;
  onNavigate: (selector: string) => void;
  onBoxModelChange: (field: string, value: string) => void;
}

/* ─── Component ────────────────────────────────────────────────────── */

export const BoxTabContent = memo(({ selectedElement, onNavigate, onBoxModelChange }: BoxTabContentProps) => {
  return (
    <div className="p-3 space-y-3">
      {/* Element Tree / Hierarchy */}
      {selectedElement.hierarchy && (
        <div className="pb-3 border-b border-bolt-elements-borderColor">
          <ElementTreeNavigator hierarchy={selectedElement.hierarchy} onSelectElement={onNavigate} />
        </div>
      )}

      {/* Box Model Editor */}
      <BoxModelEditor boxModel={selectedElement.boxModel ?? null} onValueChange={onBoxModelChange} />
    </div>
  );
});

BoxTabContent.displayName = 'BoxTabContent';
