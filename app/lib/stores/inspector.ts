import { atom } from 'nanostores';
import type {
  BulkStyleChange,
  BulkTarget,
  EditHistoryEntry,
  ElementInfo,
  InspectorConfig,
  InspectorMode,
  InspectorTab,
  ThemeData,
} from '~/lib/inspector/types';
import { DEFAULT_INSPECTOR_CONFIG } from '~/lib/inspector/types';
import type { UseInspectorReturn } from '~/lib/hooks/useInspector';

const STORAGE_KEY = 'bolt-inspector-config';

/* ------------------------------------------------------------------ */
/*  Core state                                                         */
/* ------------------------------------------------------------------ */

/** Current operating mode of the inspector. */
export const inspectorModeAtom = import.meta.hot?.data.inspectorModeAtom ?? atom<InspectorMode>('off');

/** The element currently selected in the inspector panel. */
export const selectedElementAtom = import.meta.hot?.data.selectedElementAtom ?? atom<ElementInfo | null>(null);

/** The element currently hovered in the preview. */
export const hoveredElementAtom = import.meta.hot?.data.hoveredElementAtom ?? atom<ElementInfo | null>(null);

/** Whether the inspector detail panel is visible. */
export const inspectorPanelVisibleAtom = import.meta.hot?.data.inspectorPanelVisibleAtom ?? atom<boolean>(false);

/** The active tab in the inspector detail panel. */
export const activeInspectorTabAtom = import.meta.hot?.data.activeInspectorTabAtom ?? atom<InspectorTab>('styles');

/* ------------------------------------------------------------------ */
/*  Edit tracking                                                      */
/* ------------------------------------------------------------------ */

/** Ordered undo / redo history stack. */
export const editHistoryAtom = import.meta.hot?.data.editHistoryAtom ?? atom<EditHistoryEntry[]>([]);

/** Current position (index) within the undo / redo stack. `-1` means empty. */
export const editIndexAtom = import.meta.hot?.data.editIndexAtom ?? atom<number>(-1);

/** Uncommitted style property changes keyed by property name. */
export const pendingEditsAtom = import.meta.hot?.data.pendingEditsAtom ?? atom<Record<string, string>>({});

/** Uncommitted text-content change. */
export const pendingTextEditAtom = import.meta.hot?.data.pendingTextEditAtom ?? atom<string>('');

/* ------------------------------------------------------------------ */
/*  Bulk editing                                                       */
/* ------------------------------------------------------------------ */

/** Target selector / label for bulk style operations. */
export const bulkTargetAtom = import.meta.hot?.data.bulkTargetAtom ?? atom<BulkTarget | null>(null);

/** Accumulated bulk style changes waiting to be applied. */
export const accumulatedBulkChangesAtom =
  import.meta.hot?.data.accumulatedBulkChangesAtom ?? atom<BulkStyleChange[]>([]);

/** Number of elements that will be affected by the current bulk operation. */
export const bulkAffectedCountAtom = import.meta.hot?.data.bulkAffectedCountAtom ?? atom<number | undefined>(undefined);

/* ------------------------------------------------------------------ */
/*  Theme data                                                         */
/* ------------------------------------------------------------------ */

/** Scanned theme data from the preview page (CSS variables, colors, fonts). */
export const themeDataAtom = import.meta.hot?.data.themeDataAtom ?? atom<ThemeData | null>(null);

/* ------------------------------------------------------------------ */
/*  Config (persisted)                                                 */
/* ------------------------------------------------------------------ */

/** User-configurable inspector preferences. */
export const inspectorConfigAtom =
  import.meta.hot?.data.inspectorConfigAtom ?? atom<InspectorConfig>({ ...DEFAULT_INSPECTOR_CONFIG });

/* ------------------------------------------------------------------ */
/*  Inspector API (set by Preview, consumed by BaseChat)               */
/* ------------------------------------------------------------------ */

/**
 * Holds the full `UseInspectorReturn` produced by `useInspector()` in
 * Preview.tsx so that other layout components (e.g. BaseChat) can render
 * the InspectorPanel without needing the preview iframe ref directly.
 *
 * `null` when no Preview is mounted.
 */
export const inspectorApiAtom = import.meta.hot?.data.inspectorApiAtom ?? atom<UseInspectorReturn | null>(null);

/* ------------------------------------------------------------------ */
/*  HMR persistence                                                    */
/* ------------------------------------------------------------------ */

if (import.meta.hot) {
  import.meta.hot.data.inspectorModeAtom = inspectorModeAtom;
  import.meta.hot.data.selectedElementAtom = selectedElementAtom;
  import.meta.hot.data.hoveredElementAtom = hoveredElementAtom;
  import.meta.hot.data.inspectorPanelVisibleAtom = inspectorPanelVisibleAtom;
  import.meta.hot.data.activeInspectorTabAtom = activeInspectorTabAtom;
  import.meta.hot.data.editHistoryAtom = editHistoryAtom;
  import.meta.hot.data.editIndexAtom = editIndexAtom;
  import.meta.hot.data.pendingEditsAtom = pendingEditsAtom;
  import.meta.hot.data.pendingTextEditAtom = pendingTextEditAtom;
  import.meta.hot.data.bulkTargetAtom = bulkTargetAtom;
  import.meta.hot.data.accumulatedBulkChangesAtom = accumulatedBulkChangesAtom;
  import.meta.hot.data.bulkAffectedCountAtom = bulkAffectedCountAtom;
  import.meta.hot.data.themeDataAtom = themeDataAtom;
  import.meta.hot.data.inspectorConfigAtom = inspectorConfigAtom;
  import.meta.hot.data.inspectorApiAtom = inspectorApiAtom;
}

/* ------------------------------------------------------------------ */
/*  Helper functions                                                   */
/* ------------------------------------------------------------------ */

/** Toggle inspector mode between `'off'` and `'inspect'`. */
export function toggleInspectorMode(): void {
  const current = inspectorModeAtom.get();
  inspectorModeAtom.set(current === 'off' ? 'inspect' : 'off');

  if (current !== 'off') {
    resetInspectorState();
  }
}

/** Reset all inspector state (called when disabling). */
export function resetInspectorState(): void {
  selectedElementAtom.set(null);
  hoveredElementAtom.set(null);
  inspectorPanelVisibleAtom.set(false);
  activeInspectorTabAtom.set('styles');
  pendingEditsAtom.set({});
  pendingTextEditAtom.set('');
  bulkTargetAtom.set(null);
  accumulatedBulkChangesAtom.set([]);
  bulkAffectedCountAtom.set(undefined);
}

/** Push a new edit to the history stack, truncating any redo entries. */
export function pushEdit(entry: EditHistoryEntry): void {
  const history = editHistoryAtom.get();
  const index = editIndexAtom.get();

  // Truncate everything after the current index (discard redo-able entries)
  const truncated = history.slice(0, index + 1);
  truncated.push(entry);

  editHistoryAtom.set(truncated);
  editIndexAtom.set(truncated.length - 1);
}

/** Undo the last edit. Returns the entry that was undone, or `null`. */
export function undoEdit(): EditHistoryEntry | null {
  const index = editIndexAtom.get();

  if (!canUndo()) {
    return null;
  }

  const entry = editHistoryAtom.get()[index];
  editIndexAtom.set(index - 1);

  return entry;
}

/** Redo the next edit. Returns the entry that was redone, or `null`. */
export function redoEdit(): EditHistoryEntry | null {
  if (!canRedo()) {
    return null;
  }

  const nextIndex = editIndexAtom.get() + 1;
  const entry = editHistoryAtom.get()[nextIndex];
  editIndexAtom.set(nextIndex);

  return entry;
}

/** Check whether undo is available. */
export function canUndo(): boolean {
  return editIndexAtom.get() >= 0;
}

/** Check whether redo is available. */
export function canRedo(): boolean {
  return editIndexAtom.get() < editHistoryAtom.get().length - 1;
}

/** Select a new element, resetting pending edits. */
export function selectElement(element: ElementInfo | null): void {
  selectedElementAtom.set(element);
  clearPendingEdits();

  if (element) {
    inspectorPanelVisibleAtom.set(true);
  }
}

/** Update a pending style edit (doesn't commit to history yet). */
export function updatePendingStyle(property: string, value: string): void {
  const current = pendingEditsAtom.get();
  pendingEditsAtom.set({ ...current, [property]: value });
}

/** Clear all pending edits. */
export function clearPendingEdits(): void {
  pendingEditsAtom.set({});
  pendingTextEditAtom.set('');
}

/** Add or update a bulk style change. */
export function addBulkChange(change: BulkStyleChange): void {
  const current = accumulatedBulkChangesAtom.get();

  // Replace existing change for same selector + property, or append
  const idx = current.findIndex(
    (c: BulkStyleChange) => c.selector === change.selector && c.property === change.property,
  );

  if (idx >= 0) {
    const updated = [...current];
    updated[idx] = change;
    accumulatedBulkChangesAtom.set(updated);
  } else {
    accumulatedBulkChangesAtom.set([...current, change]);
  }
}

/** Remove all bulk changes for a given selector. */
export function removeBulkChangesForSelector(selector: string): void {
  const current = accumulatedBulkChangesAtom.get();
  accumulatedBulkChangesAtom.set(current.filter((c: BulkStyleChange) => c.selector !== selector));
}

/** Clear all bulk changes. */
export function clearAllBulkChanges(): void {
  accumulatedBulkChangesAtom.set([]);
  bulkTargetAtom.set(null);
  bulkAffectedCountAtom.set(undefined);
}

/** Load config from localStorage on init. */
export function loadInspectorConfig(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (raw) {
      const parsed: Partial<InspectorConfig> = JSON.parse(raw);
      inspectorConfigAtom.set({ ...DEFAULT_INSPECTOR_CONFIG, ...parsed });
    }
  } catch {
    // Corrupt or missing data — keep defaults
  }
}

/** Save config to localStorage. */
export function saveInspectorConfig(config: Partial<InspectorConfig>): void {
  const merged: InspectorConfig = { ...inspectorConfigAtom.get(), ...config };
  inspectorConfigAtom.set(merged);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}
