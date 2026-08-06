/**
 * Styles tab content for the Inspector panel.
 *
 * Renders image editors, text editing, grouped style properties,
 * and the page color palette. Extracted from InspectorPanel for
 * better maintainability.
 *
 * @module workbench/inspector/StylesTabContent
 */

import { memo } from 'react';
import type { ElementInfo } from '~/lib/inspector/types';
import { TEXT_MAX_LENGTH } from '~/lib/inspector/constants';
import { ImageEditor } from '~/components/workbench/ImageEditor';
import { StyleGroup } from '~/components/workbench/StyleGroup';
import { DesignControl } from '~/components/workbench/DesignControl';
import { PageColorPalette } from '~/components/workbench/PageColorPalette';

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

/* ─── Style property groups ────────────────────────────────────────── */

interface PropGroup {
  label: string;
  icon: string;
  props: string[];
  defaultOpen?: boolean;
}

const STYLE_GROUPS: PropGroup[] = [
  {
    label: 'Layout',
    icon: 'i-ph:layout',
    props: ['display', 'position', 'flex-direction', 'justify-content', 'align-items', 'gap'],
  },
  {
    label: 'Size',
    icon: 'i-ph:resize',
    props: ['width', 'height', 'overflow'],
  },
  {
    label: 'Spacing',
    icon: 'i-ph:arrows-out',
    props: ['margin', 'padding'],
  },
  {
    label: 'Typography',
    icon: 'i-ph:text-aa',
    props: ['color', 'font-size', 'font-weight', 'font-family', 'text-align'],
  },
  {
    label: 'Background',
    icon: 'i-ph:paint-bucket',
    props: ['background', 'background-color'],
  },
  {
    label: 'Border',
    icon: 'i-ph:bounding-box',
    props: ['border', 'border-radius'],
  },
  {
    label: 'Effects',
    icon: 'i-ph:sparkle',
    props: ['box-shadow', 'opacity'],
  },
];

/* ─── Props ────────────────────────────────────────────────────────── */

export interface StylesTabContentProps {
  selectedElement: ElementInfo;
  pendingEdits: Record<string, string>;
  pendingTextEdit: string;
  onStyleChange: (prop: string, value: string) => void;
  onTextContentChange: (text: string) => void;
  onImageSrcChange: (src: string) => void;
  onImageAltChange: (alt: string) => void;
  onBackgroundImageChange: (value: string) => void;
  copyFeedback: string | null;
  onCopyAllStyles: () => void;
}

/* ─── Component ────────────────────────────────────────────────────── */

export const StylesTabContent = memo(
  ({
    selectedElement,
    pendingEdits,
    pendingTextEdit,
    onStyleChange,
    onTextContentChange,
    onImageSrcChange,
    onImageAltChange,
    onBackgroundImageChange,
    copyFeedback,
    onCopyAllStyles,
  }: StylesTabContentProps) => {
    return (
      <div>
        {/* Image Editor */}
        {selectedElement.isImage && selectedElement.imageSrc && (
          <div className="p-3 border-b border-bolt-elements-borderColor">
            <ImageEditor
              src={selectedElement.imageSrc}
              alt={selectedElement.imageAlt}
              naturalWidth={selectedElement.imageNaturalWidth}
              naturalHeight={selectedElement.imageNaturalHeight}
              backgroundImage={selectedElement.backgroundImage}
              onSrcChange={onImageSrcChange}
              onAltChange={onImageAltChange}
              onBackgroundImageChange={onBackgroundImageChange}
            />
          </div>
        )}

        {/* Background-image only (non-img elements) */}
        {!selectedElement.isImage && selectedElement.backgroundImage && (
          <div className="p-3 border-b border-bolt-elements-borderColor">
            <ImageEditor
              src=""
              backgroundImage={selectedElement.backgroundImage}
              onSrcChange={noop}
              onAltChange={noop}
              onBackgroundImageChange={onBackgroundImageChange}
            />
          </div>
        )}

        {/* Text Content section */}
        {selectedElement.textContent && (
          <div className="p-3 border-b border-bolt-elements-borderColor">
            <label
              htmlFor="inspector-text-content"
              className="text-xs font-medium text-bolt-elements-textSecondary block mb-1.5"
            >
              Text Content
            </label>
            <textarea
              id="inspector-text-content"
              value={pendingTextEdit || selectedElement.textContent}
              onChange={(e) => onTextContentChange(e.target.value)}
              maxLength={TEXT_MAX_LENGTH}
              className="w-full bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor rounded px-2 py-2 text-bolt-elements-textPrimary text-sm focus:outline-none focus:border-accent-400 resize-none"
              rows={2}
              placeholder="Enter text content..."
            />
            {(pendingTextEdit || selectedElement.textContent || '').length > 100 && (
              <span className="text-[10px] text-bolt-elements-textTertiary mt-1 block text-right">
                {(pendingTextEdit || selectedElement.textContent || '').length}/{TEXT_MAX_LENGTH}
              </span>
            )}
          </div>
        )}

        {/* Copy all styles */}
        <div className="p-3 border-b border-bolt-elements-borderColor">
          <button
            onClick={onCopyAllStyles}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-4 hover:text-bolt-elements-textPrimary transition-colors"
          >
            <span className="i-ph:clipboard w-3.5 h-3.5" aria-hidden="true" />
            <span aria-live="polite">{copyFeedback || 'Copy All Styles'}</span>
          </button>
        </div>

        {/* Grouped style properties */}
        {STYLE_GROUPS.map((group) => {
          const visibleProps = group.props.filter((prop) => selectedElement.styles[prop]);

          if (visibleProps.length === 0) {
            return null;
          }

          return (
            <StyleGroup key={group.label} label={group.label} icon={group.icon} defaultOpen={group.defaultOpen}>
              {visibleProps.map((prop) => (
                <DesignControl
                  key={prop}
                  property={prop}
                  value={pendingEdits[prop] ?? selectedElement.styles[prop]}
                  onChange={onStyleChange}
                  isModified={prop in pendingEdits}
                />
              ))}
            </StyleGroup>
          );
        })}

        {/* Page Color Palette */}
        {selectedElement.colors && selectedElement.colors.length > 0 && (
          <div className="p-3 border-t border-bolt-elements-borderColor">
            <PageColorPalette
              colors={selectedElement.colors}
              onColorSelect={(color) => onStyleChange('background-color', color)}
            />
          </div>
        )}
      </div>
    );
  },
);

StylesTabContent.displayName = 'StylesTabContent';
