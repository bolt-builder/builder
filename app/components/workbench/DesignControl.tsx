/**
 * Smart design control for individual CSS properties.
 *
 * Renders the appropriate input type based on the CSS property:
 * - Color picker + text input for color properties
 * - Numeric scrubber (drag-to-change) + text input for dimensional values
 * - Select dropdown for enumerable values (display, position, etc.)
 * - Plain text input as fallback
 *
 * @module workbench/DesignControl
 */

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { toHex } from '~/utils/color';

/* ─── Property metadata ──────────────────────────────────────────── */

const COLOR_PROPS = new Set(['color', 'background-color', 'border-color', 'outline-color']);

const ENUM_OPTIONS: Record<string, string[]> = {
  display: ['block', 'flex', 'grid', 'inline', 'inline-block', 'inline-flex', 'none', 'contents'],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
  'text-align': ['left', 'center', 'right', 'justify', 'start', 'end'],
  'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'],
  'justify-content': ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'],
  'align-items': ['flex-start', 'flex-end', 'center', 'stretch', 'baseline'],
  'font-weight': ['100', '200', '300', '400', '500', '600', '700', '800', '900', 'normal', 'bold'],
  overflow: ['visible', 'hidden', 'scroll', 'auto', 'clip'],
  'box-sizing': ['content-box', 'border-box'],
};

/** Properties that commonly take numeric pixel values. */
const NUMERIC_PROPS = new Set(['width', 'height', 'margin', 'padding', 'border-radius', 'gap', 'font-size', 'border']);

/** Extract a numeric pixel value from a CSS string. Returns null if not numeric. */
function parseNumericPx(value: string): number | null {
  const match = value.match(/^(-?\d+(?:\.\d+)?)\s*px$/);
  return match ? parseFloat(match[1]) : null;
}

/** Check if a value contains a parseable color. */
function parseColorFromValue(value: string): string | null {
  const hexMatch = value.match(/#([0-9a-fA-F]{3,8})/);

  if (hexMatch) {
    return hexMatch[0];
  }

  const rgbMatch = value.match(/rgba?\([^)]+\)/);

  if (rgbMatch) {
    return rgbMatch[0];
  }

  return null;
}

function isColorProperty(prop: string): boolean {
  if (COLOR_PROPS.has(prop)) {
    return true;
  }

  return prop.includes('color') || prop === 'background';
}

/* ─── Props ────────────────────────────────────────────────────────── */

interface DesignControlProps {
  /** CSS property name (kebab-case). */
  property: string;

  /** Current CSS value. */
  value: string;

  /** Called when the user changes the value. */
  onChange: (property: string, value: string) => void;

  /** Whether the value has been modified from the original. */
  isModified?: boolean;
}

/* ─── Component ────────────────────────────────────────────────────── */

export const DesignControl = memo(({ property, value, onChange, isModified = false }: DesignControlProps) => {
  const [isScrubbing, setIsScrubbing] = useState(false);
  const scrubRef = useRef<{ startX: number; startVal: number } | null>(null);
  const dragListenersRef = useRef<{ move: (ev: MouseEvent) => void; up: () => void } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const enumOptions = ENUM_OPTIONS[property];
  const color = isColorProperty(property) ? parseColorFromValue(value) : null;
  const numericVal = NUMERIC_PROPS.has(property) ? parseNumericPx(value) : null;
  const isNumeric = numericVal !== null;

  /* ── Numeric scrub (drag label to change value) ──────────────── */

  const handleLabelMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!isNumeric) {
        return;
      }

      e.preventDefault();
      setIsScrubbing(true);
      scrubRef.current = { startX: e.clientX, startVal: numericVal };

      const handleMove = (ev: MouseEvent) => {
        if (!scrubRef.current) {
          return;
        }

        const delta = Math.round((ev.clientX - scrubRef.current.startX) / 2);
        const newVal = Math.max(0, scrubRef.current.startVal + delta);
        onChange(property, newVal + 'px');
      };

      const handleUp = () => {
        setIsScrubbing(false);
        scrubRef.current = null;
        dragListenersRef.current = null;
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('mouseup', handleUp);
        document.body.style.cursor = '';
      };

      dragListenersRef.current = { move: handleMove, up: handleUp };
      document.addEventListener('mousemove', handleMove);
      document.addEventListener('mouseup', handleUp);
      document.body.style.cursor = 'ew-resize';
    },
    [isNumeric, numericVal, onChange, property],
  );

  /* ── Keyboard step for numeric values ────────────────────────── */

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!isNumeric) {
        return;
      }

      const step = e.shiftKey ? 10 : 1;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        onChange(property, numericVal + step + 'px');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        onChange(property, Math.max(0, numericVal - step) + 'px');
      }
    },
    [isNumeric, numericVal, onChange, property],
  );

  /* ── Cleanup on unmount ──────────────────────────────────────── */

  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        document.removeEventListener('mousemove', dragListenersRef.current.move);
        document.removeEventListener('mouseup', dragListenersRef.current.up);
        document.body.style.cursor = '';
      }

      scrubRef.current = null;
    };
  }, []);

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <div className="flex items-center gap-2 text-xs group">
      {/* Property label (scrubable for numeric) */}
      <span
        className={`min-w-[90px] truncate select-none ${isModified ? 'text-accent-400 font-medium' : 'text-bolt-elements-textSecondary'} ${isNumeric ? 'cursor-ew-resize hover:text-bolt-elements-textPrimary' : ''} ${isScrubbing ? 'text-accent-400' : ''}`}
        title={`${property}${isNumeric ? ' (drag to scrub)' : ''}`}
        onMouseDown={handleLabelMouseDown}
        role={isNumeric ? 'slider' : undefined}
        aria-label={isNumeric ? `Scrub ${property}` : undefined}
        aria-valuenow={isNumeric ? numericVal : undefined}
      >
        {property}
      </span>

      {/* Controls row */}
      <div className="flex-1 flex items-center gap-1">
        {/* Color swatch */}
        {color && (
          <div className="relative w-5 h-5 rounded border border-bolt-elements-borderColor shrink-0 overflow-hidden">
            <input
              type="color"
              value={toHex(color)}
              onChange={(e) => onChange(property, e.target.value)}
              className="absolute inset-0 w-[200%] h-[200%] -top-1 -left-1 cursor-pointer border-0 p-0 m-0"
              style={{ background: 'transparent' }}
              title={`Pick color for ${property}`}
              aria-label={`Color picker for ${property}`}
            />
          </div>
        )}

        {/* Dropdown for enum values */}
        {enumOptions ? (
          <select
            value={value}
            onChange={(e) => onChange(property, e.target.value)}
            className="flex-1 bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor rounded px-2 py-1 text-bolt-elements-textPrimary font-mono text-xs focus:outline-none focus:border-accent-400 appearance-none cursor-pointer"
            aria-label={`Value for ${property}`}
          >
            {/* If current value is not in options, show it */}
            {!enumOptions.includes(value) && <option value={value}>{value}</option>}
            {enumOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <input
            ref={inputRef}
            type="text"
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(property, e.target.value)}
            onKeyDown={handleKeyDown}
            className={`flex-1 bg-bolt-elements-background-depth-3 border rounded px-2 py-1 text-bolt-elements-textPrimary font-mono text-xs focus:outline-none focus:border-accent-400 ${isModified ? 'border-accent-400/50' : 'border-bolt-elements-borderColor'}`}
            aria-label={`Value for ${property}`}
          />
        )}
      </div>
    </div>
  );
});

DesignControl.displayName = 'DesignControl';
