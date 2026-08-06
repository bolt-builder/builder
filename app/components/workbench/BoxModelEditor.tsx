import { useState, useCallback, memo } from 'react';
import type { BoxModelData } from '~/lib/inspector/types';

export type { BoxModelData };

interface BoxModelEditorProps {
  boxModel: BoxModelData | null;
  onValueChange?: (property: string, value: string) => void;
}

export const BoxModelEditor = memo(({ boxModel, onValueChange }: BoxModelEditorProps) => {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');

  const handleStartEdit = useCallback((field: string, currentValue: number) => {
    setEditingField(field);
    setEditValue(String(currentValue));
  }, []);

  const handleEndEdit = useCallback(
    (field: string) => {
      if (onValueChange && editValue !== '') {
        // Parse the field to get property and side
        const [type, side] = field.split('-');
        const property = `${type}-${side}`;
        onValueChange(property, `${editValue}px`);
      }

      setEditingField(null);
      setEditValue('');
    },
    [editValue, onValueChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, field: string) => {
      if (e.key === 'Enter') {
        handleEndEdit(field);
      } else if (e.key === 'Escape') {
        setEditingField(null);
        setEditValue('');
      }
    },
    [handleEndEdit],
  );

  if (!boxModel) {
    return <div className="text-bolt-elements-textSecondary text-xs text-center py-4">No box model data available</div>;
  }

  const renderEditableValue = (field: string, value: number, textColor: string) => {
    const [type, side] = field.split('-');

    if (editingField === field) {
      return (
        <input
          type="number"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={() => handleEndEdit(field)}
          onKeyDown={(e) => handleKeyDown(e, field)}
          className="w-10 h-4 text-center text-[10px] bg-bolt-elements-background-depth-4 border border-bolt-elements-borderColor rounded focus:outline-none focus:border-accent-400"
          aria-label={`${type} ${side} value`}
          min={-9999}
          max={9999}
          autoFocus
        />
      );
    }

    const displayValue = Math.round(value);

    return (
      <button
        onClick={() => handleStartEdit(field, value)}
        className={`text-[10px] font-mono hover:bg-bolt-elements-background-depth-4 px-1 rounded cursor-pointer transition-colors ${textColor}`}
        title={`Click to edit ${field}`}
        aria-label={`Edit ${type} ${side} value`}
      >
        {displayValue}px
      </button>
    );
  };

  return (
    <div className="space-y-3" role="region" aria-label="Box model visualization">
      {/* Visual Box Model */}
      <div className="relative">
        {/* Margin Layer (outermost - orange) */}
        <div className="bg-orange-500/20 border border-orange-500/40 rounded p-1">
          <div className="text-[9px] text-orange-400 font-medium absolute top-1 left-1">margin</div>

          {/* Top margin value */}
          <div className="flex justify-center py-1">
            {renderEditableValue('margin-top', boxModel.margin.top, 'text-orange-300')}
          </div>

          <div className="flex items-center">
            {/* Left margin value */}
            <div className="flex justify-center px-2 min-w-[30px]">
              {renderEditableValue('margin-left', boxModel.margin.left, 'text-orange-300')}
            </div>

            {/* Border Layer (green) */}
            <div className="flex-1 bg-yellow-500/20 border border-yellow-500/40 rounded p-1">
              <div className="text-[9px] text-yellow-400 font-medium absolute left-8 top-8">border</div>

              {/* Top border value */}
              <div className="flex justify-center py-0.5">
                {renderEditableValue('border-top', boxModel.border.top, 'text-yellow-300')}
              </div>

              <div className="flex items-center">
                {/* Left border value */}
                <div className="flex justify-center px-1 min-w-[20px]">
                  {renderEditableValue('border-left', boxModel.border.left, 'text-yellow-300')}
                </div>

                {/* Padding Layer (green) */}
                <div className="flex-1 bg-green-500/20 border border-green-500/40 rounded p-1">
                  <div className="text-[9px] text-green-400 font-medium">padding</div>

                  {/* Top padding value */}
                  <div className="flex justify-center py-0.5">
                    {renderEditableValue('padding-top', boxModel.padding.top, 'text-green-300')}
                  </div>

                  <div className="flex items-center">
                    {/* Left padding value */}
                    <div className="flex justify-center px-1 min-w-[20px]">
                      {renderEditableValue('padding-left', boxModel.padding.left, 'text-green-300')}
                    </div>

                    {/* Content Box (center - blue) */}
                    <div className="flex-1 bg-blue-500/30 border border-blue-500/50 rounded py-3 px-2 text-center">
                      <div className="text-[10px] text-blue-300 font-mono">
                        {Math.round(boxModel.width)} × {Math.round(boxModel.height)}
                      </div>
                    </div>

                    {/* Right padding value */}
                    <div className="flex justify-center px-1 min-w-[20px]">
                      {renderEditableValue('padding-right', boxModel.padding.right, 'text-green-300')}
                    </div>
                  </div>

                  {/* Bottom padding value */}
                  <div className="flex justify-center py-0.5">
                    {renderEditableValue('padding-bottom', boxModel.padding.bottom, 'text-green-300')}
                  </div>
                </div>

                {/* Right border value */}
                <div className="flex justify-center px-1 min-w-[20px]">
                  {renderEditableValue('border-right', boxModel.border.right, 'text-yellow-300')}
                </div>
              </div>

              {/* Bottom border value */}
              <div className="flex justify-center py-0.5">
                {renderEditableValue('border-bottom', boxModel.border.bottom, 'text-yellow-300')}
              </div>
            </div>

            {/* Right margin value */}
            <div className="flex justify-center px-2 min-w-[30px]">
              {renderEditableValue('margin-right', boxModel.margin.right, 'text-orange-300')}
            </div>
          </div>

          {/* Bottom margin value */}
          <div className="flex justify-center py-1">
            {renderEditableValue('margin-bottom', boxModel.margin.bottom, 'text-orange-300')}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-[10px] justify-center pt-1">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-orange-500/30 border border-orange-500/50 rounded" />
          <span className="text-bolt-elements-textSecondary">Margin</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-yellow-500/30 border border-yellow-500/50 rounded" />
          <span className="text-bolt-elements-textSecondary">Border</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-green-500/30 border border-green-500/50 rounded" />
          <span className="text-bolt-elements-textSecondary">Padding</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-blue-500/30 border border-blue-500/50 rounded" />
          <span className="text-bolt-elements-textSecondary">Content</span>
        </div>
      </div>

      {/* Additional Info */}
      <div className="border-t border-bolt-elements-borderColor pt-2">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-bolt-elements-background-depth-3 rounded p-2 border border-bolt-elements-borderColor">
            <span className="text-bolt-elements-textSecondary block text-[10px]">Box Sizing</span>
            <span className="text-bolt-elements-textPrimary font-mono text-[11px]">{boxModel.boxSizing}</span>
          </div>
          <div className="bg-bolt-elements-background-depth-3 rounded p-2 border border-bolt-elements-borderColor">
            <span className="text-bolt-elements-textSecondary block text-[10px]">Border Style</span>
            <span className="text-bolt-elements-textPrimary font-mono text-[11px]">
              {boxModel.borderStyle || 'none'}
            </span>
          </div>
        </div>
      </div>

      {/* Tip */}
      <p className="text-bolt-elements-textTertiary text-[10px] text-center italic">
        Click any value to edit • Changes will be applied with AI
      </p>
    </div>
  );
});

BoxModelEditor.displayName = 'BoxModelEditor';
