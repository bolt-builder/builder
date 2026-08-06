import type {
  ActionType,
  BoltAction,
  BoltActionData,
  DiffAction,
  FileAction,
  ShellAction,
  SupabaseAction,
  PlanAction,
  TaskUpdateAction,
} from '~/types/actions';
import type { BoltArtifactData } from '~/types/artifact';
import type { StreamingEvent } from '~/types/streaming-events';
import { getBufferedContent, clearBufferedContent } from '~/lib/stores/stream-event-router';
import { parseSearchReplaceDiff } from '~/lib/runtime/diff/search-replace';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';

const ARTIFACT_TAG_OPEN = '<boltArtifact';
const ARTIFACT_TAG_CLOSE = '</boltArtifact>';
const ARTIFACT_ACTION_TAG_OPEN = '<boltAction';
const ARTIFACT_ACTION_TAG_CLOSE = '</boltAction>';
const BOLT_QUICK_ACTIONS_OPEN = '<bolt-quick-actions>';
const BOLT_QUICK_ACTIONS_CLOSE = '</bolt-quick-actions>';

const logger = createScopedLogger('MessageParser');

export interface ArtifactCallbackData extends BoltArtifactData {
  messageId: string;
  artifactId?: string;
}

export interface ActionCallbackData {
  artifactId: string;
  messageId: string;
  actionId: string;
  action: BoltAction;
}

export type ArtifactCallback = (data: ArtifactCallbackData) => void;
export type ActionCallback = (data: ActionCallbackData) => void;

export interface ParserCallbacks {
  onArtifactOpen?: ArtifactCallback;
  onArtifactClose?: ArtifactCallback;
  onActionOpen?: ActionCallback;
  onActionStream?: ActionCallback;
  onActionClose?: ActionCallback;
}

interface ElementFactoryProps {
  messageId: string;
  artifactId?: string;
}

type ElementFactory = (props: ElementFactoryProps) => string;

export interface StreamingMessageParserOptions {
  callbacks?: ParserCallbacks;
  artifactElement?: ElementFactory;
}

interface MessageState {
  position: number;
  insideArtifact: boolean;
  insideAction: boolean;
  artifactCounter: number;
  currentArtifact?: BoltArtifactData;
  currentAction: BoltActionData;
  actionId: number;
}

function cleanoutMarkdownSyntax(content: string) {
  const codeBlockRegex = /^\s*```\w*\n([\s\S]*?)\n\s*```\s*$/;
  const match = content.match(codeBlockRegex);

  if (match) {
    return match[1]; // Remove common leading 4-space indent
  } else {
    return content;
  }
}

function cleanEscapedTags(content: string) {
  return content.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
export class StreamingMessageParser {
  #messages = new Map<string, MessageState>();
  #artifactCounter = 0;

  /** 'legacy' = parse XML tags as today; 'structured' = skip XML, use events for actions. */
  #mode: 'legacy' | 'structured' = 'legacy';

  /** The message ID from the most recent parse() call — used by processStructuredEvent. */
  #currentMessageId: string | null = null;

  /** Artifact ID created for the structured-mode session (one per stream). */
  #structuredArtifactId: string | null = null;

  /** Monotonically-increasing action counter for structured-mode actions. */
  #structuredActionCounter = 0;

  constructor(private _options: StreamingMessageParserOptions = {}) {}

  parse(messageId: string, input: string) {
    // Track current message ID for structured mode action creation
    this.#currentMessageId = messageId;

    let state = this.#messages.get(messageId);

    if (!state) {
      state = {
        position: 0,
        insideAction: false,
        insideArtifact: false,
        artifactCounter: 0,
        currentAction: { content: '' },
        actionId: 0,
      };

      this.#messages.set(messageId, state);
    }

    /*
     * Structured mode: the server already parsed XML — just pass text through
     * as markdown. No XML tag detection is performed.
     */
    if (this.#mode === 'structured') {
      const newContent = input.slice(state.position);
      state.position = input.length;

      return newContent;
    }

    let output = '';
    let i = state.position;
    let earlyBreak = false;

    while (i < input.length) {
      if (input.startsWith(BOLT_QUICK_ACTIONS_OPEN, i)) {
        const actionsBlockEnd = input.indexOf(BOLT_QUICK_ACTIONS_CLOSE, i);

        if (actionsBlockEnd !== -1) {
          const actionsBlockContent = input.slice(i + BOLT_QUICK_ACTIONS_OPEN.length, actionsBlockEnd);

          // Find all <bolt-quick-action ...>label</bolt-quick-action> inside
          const quickActionRegex = /<bolt-quick-action([^>]*)>([\s\S]*?)<\/bolt-quick-action>/g;
          let match;
          const buttons = [];

          while ((match = quickActionRegex.exec(actionsBlockContent)) !== null) {
            const tagAttrs = match[1];
            const label = match[2];
            const type = this.#extractAttribute(tagAttrs, 'type');
            const message = this.#extractAttribute(tagAttrs, 'message');
            const path = this.#extractAttribute(tagAttrs, 'path');
            const href = this.#extractAttribute(tagAttrs, 'href');
            buttons.push(
              createQuickActionElement(
                { type: type || '', message: message || '', path: path || '', href: href || '' },
                label,
              ),
            );
          }
          output += createQuickActionGroup(buttons);
          i = actionsBlockEnd + BOLT_QUICK_ACTIONS_CLOSE.length;
          continue;
        }
      }

      if (state.insideArtifact) {
        const currentArtifact = state.currentArtifact;

        if (currentArtifact === undefined) {
          unreachable('Artifact not initialized');
        }

        if (state.insideAction) {
          const closeIndex = input.indexOf(ARTIFACT_ACTION_TAG_CLOSE, i);

          const currentAction = state.currentAction;

          if (closeIndex !== -1) {
            currentAction.content += input.slice(i, closeIndex);

            let content = currentAction.content.trim();

            if ('type' in currentAction && currentAction.type === 'file') {
              // Remove markdown code block syntax if present and file is not markdown
              if (!currentAction.filePath.endsWith('.md')) {
                content = cleanoutMarkdownSyntax(content);
                content = cleanEscapedTags(content);
              }

              content += '\n';
            }

            currentAction.content = content;

            this._options.callbacks?.onActionClose?.({
              artifactId: currentArtifact.id,
              messageId,

              /**
               * We decrement the id because it's been incremented already
               * when `onActionOpen` was emitted to make sure the ids are
               * the same.
               */
              actionId: String(state.actionId - 1),

              action: currentAction as BoltAction,
            });

            state.insideAction = false;
            state.currentAction = { content: '' };

            i = closeIndex + ARTIFACT_ACTION_TAG_CLOSE.length;
          } else {
            /*
             * No </boltAction> found yet. Check if </boltArtifact> exists — if so,
             * the LLM omitted the closing </boltAction> tag. We treat
             * </boltArtifact> as the implicit action boundary to prevent the
             * raw tag from leaking into file content.
             */
            const potentialArtifactClose = input.indexOf(ARTIFACT_TAG_CLOSE, i);

            if (potentialArtifactClose !== -1) {
              // Implicit close: LLM omitted </boltAction> for the last action
              currentAction.content += input.slice(i, potentialArtifactClose);

              let content = currentAction.content.trim();

              if ('type' in currentAction && currentAction.type === 'file') {
                if (!currentAction.filePath.endsWith('.md')) {
                  content = cleanoutMarkdownSyntax(content);
                  content = cleanEscapedTags(content);
                }

                content += '\n';
              }

              currentAction.content = content;

              this._options.callbacks?.onActionClose?.({
                artifactId: currentArtifact.id,
                messageId,
                actionId: String(state.actionId - 1),
                action: currentAction as BoltAction,
              });

              state.insideAction = false;
              state.currentAction = { content: '' };

              // Also close the artifact since the </boltArtifact> tag is what we found
              this._options.callbacks?.onArtifactClose?.({
                messageId,
                artifactId: currentArtifact.id,
                ...currentArtifact,
              });

              state.insideArtifact = false;
              state.currentArtifact = undefined;

              i = potentialArtifactClose + ARTIFACT_TAG_CLOSE.length;
            } else {
              // Pure streaming: no close tags found yet
              if ('type' in currentAction && currentAction.type === 'file') {
                let content = input.slice(i);

                /*
                 * Strip any partial bolt closing tags at the tail of the stream
                 * (e.g. "</bolt", "</boltArti") that haven't fully arrived yet.
                 */
                content = content.replace(/<\/bolt[A-Za-z]*$/g, '');

                if (!currentAction.filePath.endsWith('.md')) {
                  content = cleanoutMarkdownSyntax(content);
                  content = cleanEscapedTags(content);
                }

                this._options.callbacks?.onActionStream?.({
                  artifactId: currentArtifact.id,
                  messageId,
                  actionId: String(state.actionId - 1),
                  action: {
                    ...(currentAction as FileAction),
                    content,
                    filePath: currentAction.filePath,
                  },
                });
              }

              break;
            }
          }
        } else {
          const actionOpenIndex = input.indexOf(ARTIFACT_ACTION_TAG_OPEN, i);
          const artifactCloseIndex = input.indexOf(ARTIFACT_TAG_CLOSE, i);

          if (actionOpenIndex !== -1 && (artifactCloseIndex === -1 || actionOpenIndex < artifactCloseIndex)) {
            const actionEndIndex = input.indexOf('>', actionOpenIndex);

            if (actionEndIndex !== -1) {
              state.insideAction = true;

              state.currentAction = this.#parseActionTag(input, actionOpenIndex, actionEndIndex);

              this._options.callbacks?.onActionOpen?.({
                artifactId: currentArtifact.id,
                messageId,
                actionId: String(state.actionId++),
                action: state.currentAction as BoltAction,
              });

              i = actionEndIndex + 1;
            } else {
              break;
            }
          } else if (artifactCloseIndex !== -1) {
            this._options.callbacks?.onArtifactClose?.({
              messageId,
              artifactId: currentArtifact.id,
              ...currentArtifact,
            });

            state.insideArtifact = false;
            state.currentArtifact = undefined;

            i = artifactCloseIndex + ARTIFACT_TAG_CLOSE.length;
          } else {
            break;
          }
        }
      } else if (input[i] === '<' && input[i + 1] !== '/') {
        let j = i;
        let potentialTag = '';

        while (j < input.length && potentialTag.length < ARTIFACT_TAG_OPEN.length) {
          potentialTag += input[j];

          if (potentialTag === ARTIFACT_TAG_OPEN) {
            const nextChar = input[j + 1];

            if (nextChar && nextChar !== '>' && nextChar !== ' ') {
              output += input.slice(i, j + 1);
              i = j + 1;
              break;
            }

            const openTagEnd = input.indexOf('>', j);

            if (openTagEnd !== -1) {
              const artifactTag = input.slice(i, openTagEnd + 1);

              const artifactTitle = this.#extractAttribute(artifactTag, 'title') as string;
              const type = this.#extractAttribute(artifactTag, 'type') as string;

              // const artifactId = this.#extractAttribute(artifactTag, 'id') as string;
              const artifactId = `${messageId}-${state.artifactCounter++}`;

              if (!artifactTitle) {
                logger.warn('Artifact title missing');
              }

              if (!artifactId) {
                logger.warn('Artifact id missing');
              }

              state.insideArtifact = true;

              const currentArtifact = {
                id: artifactId,
                title: artifactTitle,
                type,
                preloaded: this.#extractAttribute(artifactTag, 'preloaded') === 'true',
              } satisfies BoltArtifactData;

              state.currentArtifact = currentArtifact;

              this._options.callbacks?.onArtifactOpen?.({
                messageId,
                artifactId: currentArtifact.id,
                ...currentArtifact,
              });

              const artifactFactory = this._options.artifactElement ?? createArtifactElement;

              output += artifactFactory({ messageId, artifactId });

              i = openTagEnd + 1;
            } else {
              earlyBreak = true;
            }

            break;
          } else if (!ARTIFACT_TAG_OPEN.startsWith(potentialTag)) {
            output += input.slice(i, j + 1);
            i = j + 1;
            break;
          }

          j++;
        }

        if (j === input.length && ARTIFACT_TAG_OPEN.startsWith(potentialTag)) {
          break;
        }
      } else {
        /*
         * Note: Auto-file-creation from code blocks is now handled by EnhancedMessageParser
         * to avoid duplicate processing and provide better shell command detection
         */
        output += input[i];
        i++;
      }

      if (earlyBreak) {
        break;
      }
    }

    state.position = i;

    return output;
  }

  /**
   * Process a validated streaming event in dual-mode operation.
   *
   * - `stream_start` with protocol `structured-v1` switches the parser to
   *   structured mode, creating a virtual artifact context for subsequent
   *   action dispatches.
   * - `file_close` retrieves buffered content from StreamEventRouter, builds
   *   a FileAction or DiffAction, and dispatches via the existing
   *   onActionOpen / onActionClose callbacks (same path as legacy XML mode).
   * - All other events are no-ops here — they are already handled by the
   *   StreamEventRouter for store updates.
   */
  processStructuredEvent(event: StreamingEvent): void {
    if (event.type === 'stream_start' && event.protocol === 'structured-v1') {
      this.#mode = 'structured';

      /*
       * Create a virtual artifact so downstream callbacks (addAction, runAction)
       * have an artifact context, just like legacy XML mode.
       * If currentMessageId isn't set yet (event arrived before parse()), use
       * the artifactId from the event or generate a fallback.
       */
      const messageId = this.#currentMessageId ?? event.artifactId ?? `structured-${Date.now()}`;
      this.#structuredArtifactId = `${messageId}-structured-${this.#artifactCounter++}`;
      this.#structuredActionCounter = 0;

      this._options.callbacks?.onArtifactOpen?.({
        messageId,
        artifactId: this.#structuredArtifactId,
        id: this.#structuredArtifactId,
        title: 'Code Changes',
        type: 'bundled',
      });

      logger.debug('Switched to structured mode, artifact:', this.#structuredArtifactId);

      return;
    }

    // Only handle file_close events in structured mode for action creation
    if (this.#mode !== 'structured') {
      return;
    }

    if (event.type === 'file_close') {
      const buffered = getBufferedContent(event.filePath);
      clearBufferedContent(event.filePath);

      if (!buffered) {
        logger.warn(`No buffered content for ${event.filePath} on file_close — skipping action creation`);
        return;
      }

      const messageId = this.#currentMessageId ?? 'unknown';
      const artifactId = this.#structuredArtifactId ?? 'unknown';
      const actionId = String(this.#structuredActionCounter++);

      if (buffered.format === 'full_content') {
        const action: FileAction = {
          type: 'file',
          filePath: event.filePath,
          content: buffered.content,
        };

        this._options.callbacks?.onActionOpen?.({ artifactId, messageId, actionId, action });
        this._options.callbacks?.onActionClose?.({ artifactId, messageId, actionId, action });
      } else if (buffered.format === 'search_replace') {
        const { blocks } = parseSearchReplaceDiff(buffered.content);
        const action: DiffAction = {
          type: 'diff',
          filePath: event.filePath,
          content: buffered.content,
          diffBlocks: blocks,
        };

        this._options.callbacks?.onActionOpen?.({ artifactId, messageId, actionId, action });
        this._options.callbacks?.onActionClose?.({ artifactId, messageId, actionId, action });
      } else {
        logger.warn(`Unknown buffer format for ${event.filePath}: ${(buffered as { format: string }).format}`);
      }
    }
  }

  /** Returns the current parser mode. */
  get mode(): 'legacy' | 'structured' {
    return this.#mode;
  }

  reset() {
    this.#messages.clear();
    this.#mode = 'legacy';
    this.#currentMessageId = null;
    this.#structuredArtifactId = null;
    this.#structuredActionCounter = 0;
  }

  #parseActionTag(input: string, actionOpenIndex: number, actionEndIndex: number) {
    const actionTag = input.slice(actionOpenIndex, actionEndIndex + 1);

    const actionType = this.#extractAttribute(actionTag, 'type') as ActionType;

    const actionAttributes = {
      type: actionType,
      content: '',
    };

    if (actionType === 'supabase') {
      const operation = this.#extractAttribute(actionTag, 'operation');

      if (!operation || !['migration', 'query'].includes(operation)) {
        logger.warn(`Invalid or missing operation for Supabase action: ${operation}, defaulting to 'query'`);
      }

      (actionAttributes as SupabaseAction).operation =
        operation && ['migration', 'query'].includes(operation) ? (operation as 'migration' | 'query') : 'query';

      if (operation === 'migration') {
        const filePath = this.#extractAttribute(actionTag, 'filePath');

        if (!filePath) {
          logger.warn('Migration action missing filePath, using placeholder');
        }

        (actionAttributes as SupabaseAction).filePath = filePath || 'supabase/migrations/unknown.sql';
      }
    } else if (actionType === 'file') {
      const filePath = this.#extractAttribute(actionTag, 'filePath') as string;

      if (!filePath) {
        logger.debug('File path not specified');
      }

      (actionAttributes as FileAction).filePath = filePath;
    } else if (actionType === 'plan') {
      // Plan action - extract optional title attribute
      const planTitle = this.#extractAttribute(actionTag, 'title');

      if (planTitle) {
        (actionAttributes as PlanAction).planTitle = planTitle;
      }
    } else if (actionType === 'task-update') {
      // Task update action - extract taskId and taskStatus attributes
      const taskId = this.#extractAttribute(actionTag, 'taskId');
      const taskStatus = this.#extractAttribute(actionTag, 'status') as TaskUpdateAction['taskStatus'];

      if (!taskId) {
        logger.warn('Task update requires a taskId');
      }

      if (!taskStatus) {
        logger.warn('Task update requires a status');
      }

      (actionAttributes as TaskUpdateAction).taskId = taskId || '';
      (actionAttributes as TaskUpdateAction).taskStatus = taskStatus || 'not-started';
    } else if (!['shell', 'start', 'build'].includes(actionType)) {
      logger.warn(`Unknown action type '${actionType}'`);
    }

    return actionAttributes as FileAction | ShellAction | PlanAction | TaskUpdateAction;
  }

  #extractAttribute(tag: string, attributeName: string): string | undefined {
    const match = tag.match(new RegExp(`${attributeName}=["']([^"']*)["']`, 'i'));
    return match ? match[1] : undefined;
  }
}

const createArtifactElement: ElementFactory = (props) => {
  const elementProps = [
    'class="__boltArtifact__"',
    ...Object.entries(props).map(([key, value]) => {
      return `data-${camelToDashCase(key)}=${JSON.stringify(value)}`;
    }),
  ];

  return `<div ${elementProps.join(' ')}></div>`;
};

function camelToDashCase(input: string) {
  return input.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function createQuickActionElement(props: Record<string, string>, label: string) {
  const elementProps = [
    'class="__boltQuickAction__"',
    'data-bolt-quick-action="true"',
    ...Object.entries(props).map(([key, value]) => `data-${camelToDashCase(key)}=${JSON.stringify(value)}`),
  ];

  return `<button ${elementProps.join(' ')}>${label}</button>`;
}

function createQuickActionGroup(buttons: string[]) {
  return `<div class="__boltQuickAction__" data-bolt-quick-action="true">${buttons.join('')}</div>`;
}
