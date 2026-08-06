import { memo, useState, useCallback, useMemo, useRef, useEffect, type KeyboardEvent } from 'react';
import { createScopedLogger } from '~/utils/logger';
import { toHex, isLightColor } from '~/utils/color';
import { COLOR_COPY_TIMEOUT_MS, COPY_FEEDBACK_TIMEOUT_MS, MAX_PALETTE_COLORS } from '~/lib/inspector/constants';

const logger = createScopedLogger('ColorPalette');

interface PageColorPaletteProps {
  colors: string[];
  onColorSelect?: (color: string) => void;
}

export const PageColorPalette = memo(({ colors, onColorSelect }: PageColorPaletteProps) => {
  const [copiedColor, setCopiedColor] = useState<string | null>(null);
  const [appliedColor, setAppliedColor] = useState<string | null>(null);
  const appliedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (appliedTimerRef.current) {
        clearTimeout(appliedTimerRef.current);
      }
    };
  }, []);

  const handleCopyColor = useCallback(async (color: string) => {
    const hex = toHex(color);

    try {
      await navigator.clipboard.writeText(hex);
      setCopiedColor(hex);
      setTimeout(() => setCopiedColor(null), COLOR_COPY_TIMEOUT_MS);
    } catch {
      logger.error('Failed to copy color');
    }
  }, []);

  const handleSelectColor = useCallback(
    (color: string) => {
      const hex = toHex(color);
      onColorSelect?.(hex);
      setAppliedColor(hex);

      if (appliedTimerRef.current) {
        clearTimeout(appliedTimerRef.current);
      }

      appliedTimerRef.current = setTimeout(() => setAppliedColor(null), COPY_FEEDBACK_TIMEOUT_MS);
    },
    [onColorSelect],
  );

  if (!colors || colors.length === 0) {
    return (
      <div className="text-center py-4 text-bolt-elements-textTertiary text-xs">
        <div className="i-ph:palette w-6 h-6 mx-auto mb-2 opacity-40" />
        <p>No colors detected</p>
      </div>
    );
  }

  // Deduplicate and limit colors
  const uniqueColors = useMemo(() => [...new Set(colors.map((c) => toHex(c)))].slice(0, MAX_PALETTE_COLORS), [colors]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] text-bolt-elements-textTertiary uppercase tracking-wide">
          <span className="i-ph:palette w-3 h-3" />
          Page Colors ({uniqueColors.length})
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {uniqueColors.map((color, index) => {
          const hex = toHex(color);
          const isLight = isLightColor(color);
          const isCopied = copiedColor === hex;

          return (
            <div key={`${color}-${index}`} className="flex flex-col items-center gap-1">
              <button
                onClick={() => handleCopyColor(color)}
                onDoubleClick={() => handleSelectColor(color)}
                onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSelectColor(color);
                  } else if (e.key === ' ') {
                    e.preventDefault();
                    handleCopyColor(color);
                  }
                }}
                className={`w-10 h-10 rounded-lg border-2 transition-all hover:scale-110 hover:shadow-lg relative group ${appliedColor === hex ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-transparent' : ''}`}
                style={{
                  backgroundColor: color,
                  borderColor: isLight ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.2)',
                }}
                title={`${hex}\nClick to copy, double-click to use`}
                aria-label={`Color ${hex}, click to copy, double-click to apply`}
              >
                {isCopied && (
                  <span
                    role="status"
                    aria-live="polite"
                    className={`absolute inset-0 flex items-center justify-center text-xs font-bold ${
                      isLight ? 'text-gray-800' : 'text-white'
                    }`}
                  >
                    Copied!
                  </span>
                )}
                <span
                  className={`absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity ${
                    isLight ? 'text-gray-800' : 'text-white'
                  }`}
                >
                  <span className="i-ph:copy w-4 h-4" />
                </span>
              </button>
              <span className="text-[9px] text-bolt-elements-textTertiary font-mono truncate max-w-[44px]">
                {hex.slice(1).toUpperCase()}
              </span>
            </div>
          );
        })}
      </div>

      <div className="pt-2 border-t border-bolt-elements-borderColor">
        <p className="text-[10px] text-bolt-elements-textTertiary text-center">Click to copy • Double-click to apply</p>
      </div>
    </div>
  );
});

PageColorPalette.displayName = 'PageColorPalette';
