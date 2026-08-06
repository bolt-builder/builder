/**
 * Theme editor panel for the Element Inspector.
 *
 * Displays and allows editing of page-wide design tokens:
 * - CSS custom properties (variables) with color pickers for color values
 * - Dominant colors used across the page
 * - Font families in use with their weights
 *
 * Triggers a theme scan on mount and provides a manual refresh button.
 *
 * @module workbench/ThemeEditor
 */

import { memo, useState, useCallback, useEffect, useRef } from 'react';
import type { ThemeData, CSSVariable, PageColor, PageFont } from '~/lib/inspector/types';

/* ─── Props ────────────────────────────────────────────────────────── */

interface ThemeEditorProps {
  /** Scanned theme data from the preview page. */
  themeData: ThemeData | null;

  /** Trigger a full theme re-scan. */
  onScanTheme: () => void;

  /** Edit a CSS custom property value. */
  onEditCSSVar: (name: string, value: string) => void;

  /** Apply a style change to the selected element (for color/font shortcuts). */
  onStyleChange: (property: string, value: string) => void;
}

/* ─── Sub-components ───────────────────────────────────────────────── */

/** Individual CSS variable row with inline editing. */
const VariableRow = memo(
  ({ variable, onEdit }: { variable: CSSVariable; onEdit: (name: string, value: string) => void }) => {
    const [localValue, setLocalValue] = useState(variable.value);
    const [isEditing, setIsEditing] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // Sync local value when variable changes externally
    useEffect(() => {
      if (!isEditing) {
        setLocalValue(variable.value);
      }
    }, [variable.value, isEditing]);

    const handleCommit = useCallback(() => {
      setIsEditing(false);

      if (localValue.trim() !== variable.value) {
        onEdit(variable.name, localValue.trim());
      }
    }, [localValue, variable.name, variable.value, onEdit]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          handleCommit();
        } else if (e.key === 'Escape') {
          setLocalValue(variable.value);
          setIsEditing(false);
        }
      },
      [handleCommit, variable.value],
    );

    const handleFocus = useCallback(() => {
      setIsEditing(true);
    }, []);

    const handleColorChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const newColor = e.target.value;
        setLocalValue(newColor);
        onEdit(variable.name, newColor);
      },
      [variable.name, onEdit],
    );

    return (
      <div className="flex items-center gap-2 py-1.5 px-3 hover:bg-bolt-elements-background-depth-3 transition-colors group">
        {/* Color swatch (if color variable) */}
        {variable.isColor && (
          <label className="relative shrink-0" aria-label={`Color picker for ${variable.name}`}>
            <span
              className="block w-4 h-4 rounded border border-bolt-elements-borderColor cursor-pointer"
              style={{ backgroundColor: localValue }}
            />
            <input
              type="color"
              value={localValue.startsWith('#') ? localValue : '#000000'}
              onChange={handleColorChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              tabIndex={-1}
            />
          </label>
        )}

        {/* Variable name */}
        <span
          className="text-[10px] font-mono text-bolt-elements-textSecondary truncate min-w-0 flex-shrink"
          title={variable.name}
        >
          {variable.name}
        </span>

        {/* Value input */}
        <input
          ref={inputRef}
          type="text"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          className="ml-auto text-[10px] font-mono bg-transparent text-bolt-elements-textPrimary border-b border-transparent focus:border-accent-400 outline-none w-24 text-right transition-colors"
          aria-label={`Value for ${variable.name}`}
        />

        {/* Usage badge */}
        {variable.usageCount > 0 && (
          <span
            className="text-[9px] bg-bolt-elements-background-depth-4 text-bolt-elements-textTertiary px-1 py-0.5 rounded shrink-0"
            title={`Used by ${variable.usageCount} element(s)`}
          >
            {variable.usageCount}
          </span>
        )}
      </div>
    );
  },
);

VariableRow.displayName = 'VariableRow';

/** Color swatch grid showing dominant page colors. */
const ColorGrid = memo(({ colors, onColorSelect }: { colors: PageColor[]; onColorSelect: (color: string) => void }) => {
  if (colors.length === 0) {
    return <p className="text-[10px] text-bolt-elements-textTertiary text-center py-2">No dominant colors found</p>;
  }

  return (
    <div className="grid grid-cols-5 gap-1.5 p-3">
      {colors.map((color, idx) => (
        <button
          key={`${color.value}-${idx}`}
          onClick={() => onColorSelect(color.value)}
          className="group relative aspect-square rounded border border-bolt-elements-borderColor hover:border-accent-400 transition-colors overflow-hidden"
          style={{ backgroundColor: color.value }}
          title={`${color.value} (${color.count} uses)\n${color.properties.join(', ')}`}
          aria-label={`Apply color ${color.value}, used ${color.count} times`}
        >
          {/* Usage count overlay */}
          <span className="absolute bottom-0 right-0 text-[8px] bg-black/60 text-white/80 px-1 rounded-tl opacity-0 group-hover:opacity-100 transition-opacity">
            {color.count}
          </span>
        </button>
      ))}
    </div>
  );
});

ColorGrid.displayName = 'ColorGrid';

/** Font family list. */
const FontList = memo(({ fonts, onFontSelect }: { fonts: PageFont[]; onFontSelect: (family: string) => void }) => {
  if (fonts.length === 0) {
    return <p className="text-[10px] text-bolt-elements-textTertiary text-center py-2">No fonts detected</p>;
  }

  return (
    <div className="space-y-1">
      {fonts.map((font) => (
        <button
          key={font.family}
          onClick={() => onFontSelect(font.family)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-bolt-elements-background-depth-3 transition-colors rounded text-left"
          title={`Apply ${font.family} to selected element`}
          aria-label={`Apply font ${font.family}`}
        >
          <span className="text-bolt-elements-textPrimary truncate" style={{ fontFamily: font.family }}>
            {font.family}
          </span>
          <span className="flex items-center gap-1.5 shrink-0 ml-2">
            <span className="text-[9px] text-bolt-elements-textTertiary">{font.count} uses</span>
            <span className="text-[9px] text-bolt-elements-textTertiary bg-bolt-elements-background-depth-4 px-1 py-0.5 rounded">
              {font.weights.length}w
            </span>
          </span>
        </button>
      ))}
    </div>
  );
});

FontList.displayName = 'FontList';

/* ─── Section header ───────────────────────────────────────────────── */

const SectionHeader = memo(
  ({
    icon,
    label,
    count,
    isOpen,
    onToggle,
  }: {
    icon: string;
    label: string;
    count: number;
    isOpen: boolean;
    onToggle: () => void;
  }) => (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3 transition-colors border-b border-bolt-elements-borderColor"
      aria-expanded={isOpen}
    >
      <div className={`${icon} w-3.5 h-3.5`} aria-hidden="true" />
      <span>{label}</span>
      {count > 0 && (
        <span className="text-[9px] bg-bolt-elements-background-depth-4 text-bolt-elements-textTertiary px-1.5 py-0.5 rounded-full">
          {count}
        </span>
      )}
      <div
        className={`i-ph:caret-down w-3 h-3 ml-auto transition-transform ${isOpen ? '' : '-rotate-90'}`}
        aria-hidden="true"
      />
    </button>
  ),
);

SectionHeader.displayName = 'SectionHeader';

/* ─── Main Component ───────────────────────────────────────────────── */

export const ThemeEditor = memo(({ themeData, onScanTheme, onEditCSSVar, onStyleChange }: ThemeEditorProps) => {
  const [showVars, setShowVars] = useState(true);
  const [showColors, setShowColors] = useState(true);
  const [showFonts, setShowFonts] = useState(true);
  const [filterText, setFilterText] = useState('');
  const hasScanned = useRef(false);

  // Auto-scan on first mount
  useEffect(() => {
    if (!hasScanned.current) {
      hasScanned.current = true;
      onScanTheme();
    }
  }, [onScanTheme]);

  /* ── Color shortcuts ───────────────────────────────────────────── */

  const handleColorSelect = useCallback(
    (color: string) => {
      onStyleChange('color', color);
    },
    [onStyleChange],
  );

  const handleFontSelect = useCallback(
    (family: string) => {
      onStyleChange('font-family', family);
    },
    [onStyleChange],
  );

  /* ── Loading state ─────────────────────────────────────────────── */

  if (!themeData) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
        <div className="i-ph:circle-notch w-6 h-6 text-accent-400 animate-spin mb-3" aria-hidden="true" />
        <p className="text-xs text-bolt-elements-textSecondary">Scanning page theme...</p>
        <button
          onClick={onScanTheme}
          className="mt-3 text-[10px] text-accent-400 hover:text-accent-300 transition-colors underline"
        >
          Retry scan
        </button>
      </div>
    );
  }

  /* ── Filter variables ──────────────────────────────────────────── */

  const filteredVars = filterText
    ? themeData.variables.filter(
        (v) =>
          v.name.toLowerCase().includes(filterText.toLowerCase()) ||
          v.value.toLowerCase().includes(filterText.toLowerCase()),
      )
    : themeData.variables;

  const colorVars = filteredVars.filter((v) => v.isColor);
  const otherVars = filteredVars.filter((v) => !v.isColor);

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-3 border-b border-bolt-elements-borderColor">
        <div className="relative flex-1">
          <div className="i-ph:magnifying-glass w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-bolt-elements-textTertiary" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter variables..."
            className="w-full bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor rounded pl-7 pr-2 py-1.5 text-xs text-bolt-elements-textPrimary focus:outline-none focus:border-accent-400"
            aria-label="Filter CSS variables"
          />
        </div>
        <button
          onClick={onScanTheme}
          className="p-1.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:text-accent-400 hover:border-accent-400 transition-colors"
          title="Re-scan page theme"
          aria-label="Re-scan page theme"
        >
          <div className="i-ph:arrows-clockwise w-3.5 h-3.5" />
        </button>
      </div>

      {/* CSS Variables - Color */}
      {colorVars.length > 0 && (
        <div>
          <SectionHeader
            icon="i-ph:palette"
            label="Color Variables"
            count={colorVars.length}
            isOpen={showVars}
            onToggle={() => setShowVars(!showVars)}
          />
          {showVars && (
            <div className="py-1">
              {colorVars.map((v) => (
                <VariableRow key={v.name} variable={v} onEdit={onEditCSSVar} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* CSS Variables - Other */}
      {otherVars.length > 0 && (
        <div>
          <SectionHeader
            icon="i-ph:code"
            label="Other Variables"
            count={otherVars.length}
            isOpen={showVars && colorVars.length === 0}
            onToggle={() => setShowVars(!showVars)}
          />
          {showVars && (
            <div className="py-1">
              {otherVars.map((v) => (
                <VariableRow key={v.name} variable={v} onEdit={onEditCSSVar} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* No variables message */}
      {filteredVars.length === 0 && themeData.variables.length > 0 && (
        <p className="text-[10px] text-bolt-elements-textTertiary text-center py-3">
          No variables matching &ldquo;{filterText}&rdquo;
        </p>
      )}

      {filteredVars.length === 0 && themeData.variables.length === 0 && (
        <div className="px-3 py-4 text-center">
          <p className="text-[10px] text-bolt-elements-textTertiary">No CSS custom properties found on this page.</p>
          <p className="text-[10px] text-bolt-elements-textTertiary mt-1">
            Add <code className="bg-bolt-elements-background-depth-3 px-1 rounded">--variable-name</code> to{' '}
            <code className="bg-bolt-elements-background-depth-3 px-1 rounded">:root</code> to see them here.
          </p>
        </div>
      )}

      {/* Dominant Colors */}
      <SectionHeader
        icon="i-ph:drop"
        label="Page Colors"
        count={themeData.colors.length}
        isOpen={showColors}
        onToggle={() => setShowColors(!showColors)}
      />
      {showColors && <ColorGrid colors={themeData.colors} onColorSelect={handleColorSelect} />}

      {/* Fonts */}
      <SectionHeader
        icon="i-ph:text-aa"
        label="Fonts"
        count={themeData.fonts.length}
        isOpen={showFonts}
        onToggle={() => setShowFonts(!showFonts)}
      />
      {showFonts && (
        <div className="py-1">
          <FontList fonts={themeData.fonts} onFontSelect={handleFontSelect} />
        </div>
      )}
    </div>
  );
});

ThemeEditor.displayName = 'ThemeEditor';
