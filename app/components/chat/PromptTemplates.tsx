import * as Popover from '@radix-ui/react-popover';
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'sonner';
import { cn } from '~/utils/cn';
import { IconButton } from '~/components/ui/IconButton';
import {
  BUILT_IN_TEMPLATES,
  addUserTemplate,
  removeUserTemplate,
  userTemplatesStore,
  type PromptTemplate,
} from '~/lib/stores/promptTemplates';

interface PromptTemplatesProps {
  /** Current chat input value, used when saving it as a new template. */
  input: string;

  /** Inserts template text into the chat input. */
  onInsert: (text: string) => void;
}

/**
 * Prompt template picker: a toolbar popover with curated built-in prompts and
 * user-saved templates. Selecting one inserts its text into the chat input;
 * the current input can be saved as a reusable template.
 */
export function PromptTemplates({ input, onInsert }: PromptTemplatesProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const userTemplates = useStore(userTemplatesStore);

  const handleSelect = (template: PromptTemplate) => {
    onInsert(template.text);
    setOpen(false);
  };

  const handleSave = () => {
    const label = newLabel.trim();

    if (!label || !input.trim()) {
      return;
    }

    addUserTemplate(label, input.trim());
    setNewLabel('');
    setSaving(false);
    toast.success('Prompt template saved');
  };

  const renderTemplate = (template: PromptTemplate) => (
    <div key={template.id} className="group flex items-center">
      <button
        onClick={() => handleSelect(template)}
        title={template.text}
        className={cn(
          'flex-1 min-w-0 flex flex-col items-start gap-0.5 px-3 py-2 rounded-md text-left transition-colors border-none bg-transparent',
          'text-[#9ca3af] hover:bg-[#1a1f2e] hover:text-white',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-focus',
        )}
      >
        <span className="text-sm font-medium">{template.label}</span>
        <span className="w-full text-xs opacity-60 truncate">{template.text}</span>
      </button>
      {!template.builtIn && (
        <button
          onClick={() => removeUserTemplate(template.id)}
          aria-label={`Delete template ${template.label}`}
          className="i-ph:trash shrink-0 text-sm mx-2 text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentDanger opacity-0 group-hover:opacity-100 transition-opacity bg-transparent border-none"
        />
      )}
    </div>
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton
          title="Prompt templates"
          className={cn(
            'transition-all',
            open
              ? 'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
              : 'bg-bolt-elements-item-backgroundDefault text-bolt-elements-item-contentDefault',
          )}
        >
          <div className="i-ph:bookmark-simple text-xl" />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          side="top"
          align="start"
          className="rounded-lg z-workbench border border-[#1e293b] overflow-hidden w-[320px]"
          style={{ backgroundColor: '#0f1219', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}
        >
          <div className="p-1 max-h-[360px] overflow-y-auto" style={{ backgroundColor: '#0f1219' }}>
            {userTemplates.length > 0 && (
              <>
                <div className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-bolt-elements-textTertiary">
                  Your templates
                </div>
                {userTemplates.map(renderTemplate)}
              </>
            )}
            <div className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-bolt-elements-textTertiary">
              Built-in
            </div>
            {BUILT_IN_TEMPLATES.map(renderTemplate)}
          </div>
          <div className="border-t border-[#1e293b] p-2" style={{ backgroundColor: '#0f1219' }}>
            {saving ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSave();
                    }

                    if (e.key === 'Escape') {
                      setSaving(false);
                    }
                  }}
                  placeholder="Template name"
                  className="flex-1 min-w-0 px-2 py-1.5 text-sm rounded-md bg-[#1a1f2e] text-white border border-[#1e293b] focus:outline-none focus:ring-2 focus:ring-bolt-elements-focus"
                />
                <button
                  onClick={handleSave}
                  disabled={!newLabel.trim() || !input.trim()}
                  className="px-2 py-1.5 text-sm rounded-md border-none bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            ) : (
              <button
                onClick={() => setSaving(true)}
                disabled={!input.trim()}
                title={input.trim() ? 'Save the current input as a template' : 'Type a prompt first, then save it'}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-left text-sm transition-colors border-none bg-transparent text-[#9ca3af] hover:bg-[#1a1f2e] hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <div className="i-ph:plus text-base" />
                Save current input as template
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
