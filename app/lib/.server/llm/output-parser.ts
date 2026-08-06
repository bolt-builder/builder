/**
 * Server-side LLM Output Parser — Chunk-by-chunk State Machine
 *
 * Consumes raw LLM text output containing boltArtifact/boltAction XML tags
 * and emits typed StreamingEvent objects. Runs server-side only.
 *
 * Architecture inspired by vibesdk's SCOF streaming format parser with
 * explicit state machine and partial-buffer carry-over between chunks.
 *
 * @module lib/.server/llm/output-parser
 */

import type {
  StreamingEvent,
  FileOpenEvent,
  FileChunkEvent,
  FileCloseEvent,
  PhaseChangeEvent,
  ErrorEvent,
} from '~/types/streaming-events';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ServerOutputParser');

// ─── Constants ──────────────────────────────────────────────────────────────

const ARTIFACT_TAG_OPEN = '<boltArtifact';
const ARTIFACT_TAG_CLOSE = '</boltArtifact>';
const ACTION_TAG_OPEN = '<boltAction';
const ACTION_TAG_CLOSE = '</boltAction>';

/** Special token prefix emitted by the phase pipeline. */
const PHASE_TOKEN_PREFIX = '__phase:';

/** Maximum bytes to buffer before forcing a flush (1 MB). */
const MAX_ACCUMULATOR_BYTES = 1_048_576;

/** Maximum bytes of input with no event emitted before deadlock recovery (10 KB). */
const DEADLOCK_THRESHOLD = 10_240;

/** Incremental chunk size for file_chunk events (characters). */
const CHUNK_FLUSH_SIZE = 4096;

// ─── State Machine ──────────────────────────────────────────────────────────

/** Parser states form a strict linear progression with reset on close/error. */
export enum ParserState {
  /** Not inside any artifact or action tag. */
  Idle = 'idle',

  /** Inside a <boltArtifact> but not inside any <boltAction>. */
  InsideArtifact = 'inside_artifact',

  /** Inside a <boltAction> within an artifact — content is being streamed. */
  InsideAction = 'inside_action',
}

// ─── Internal State ─────────────────────────────────────────────────────────

interface ParserInternalState {
  state: ParserState;

  /** Partial tag buffer for XML tags split across chunk boundaries. */
  partialTag: string;

  /** Current artifact identifier (from the `identifier` or computed id). */
  currentArtifactId: string | null;

  /** Current artifact title. */
  currentArtifactTitle: string | null;

  /** Current file path being streamed. */
  currentFilePath: string | null;

  /** Accumulated content for the current action, flushed incrementally. */
  contentAccumulator: string;

  /** Total bytes processed since last event emission (for deadlock detection). */
  bytesSinceLastEvent: number;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

export class ServerOutputParser {
  #state: ParserInternalState;

  constructor() {
    this.#state = this.#createInitialState();
  }

  /**
   * Parse a single chunk of raw LLM output and return typed streaming events.
   * Maintains internal state between calls to handle chunk boundaries.
   */
  parseChunk(chunk: string): StreamingEvent[] {
    if (chunk.length === 0) {
      return [];
    }

    const events: StreamingEvent[] = [];
    const s = this.#state;

    // Prepend any partial tag buffer from the previous chunk
    const input = s.partialTag + chunk;
    s.partialTag = '';

    let i = 0;

    while (i < input.length) {
      // ── Deadlock detection ──────────────────────────────────────────────
      if (s.bytesSinceLastEvent > DEADLOCK_THRESHOLD) {
        logger.warn('Deadlock detected: no event emitted after 10KB of input — resetting parser');
        events.push(this.#makeError('PARSER_DEADLOCK', 'Parser state machine deadlock — forcing reset', true));
        this.#forceReset(s);

        // Continue parsing from current position in idle state
      }

      // ── Phase token detection (can appear in any state) ─────────────────
      if (input.startsWith(PHASE_TOKEN_PREFIX, i)) {
        const lineEnd = input.indexOf('\n', i);

        if (lineEnd === -1) {
          // Phase token may be split across chunks — save as partial
          s.partialTag = input.slice(i);
          break;
        }

        const phaseName = input.slice(i + PHASE_TOKEN_PREFIX.length, lineEnd).trim();

        if (phaseName.length > 0) {
          events.push(this.#makePhaseChange(phaseName));
          s.bytesSinceLastEvent = 0;
        }

        i = lineEnd + 1;
        continue;
      }

      // ── State-specific parsing ──────────────────────────────────────────
      switch (s.state) {
        case ParserState.Idle: {
          const consumed = this.#parseIdle(input, i, events);

          if (consumed === -1) {
            // Partial tag at end of input — save for next chunk
            i = input.length;
          } else {
            i = consumed;
          }

          break;
        }

        case ParserState.InsideArtifact: {
          const consumed = this.#parseInsideArtifact(input, i, events);

          if (consumed === -1) {
            i = input.length;
          } else {
            i = consumed;
          }

          break;
        }

        case ParserState.InsideAction: {
          const consumed = this.#parseInsideAction(input, i, events);

          if (consumed === -1) {
            i = input.length;
          } else {
            i = consumed;
          }

          break;
        }
      }
    }

    // ── Memory protection: flush accumulator if it exceeds cap ──────────
    if (s.contentAccumulator.length > MAX_ACCUMULATOR_BYTES && s.currentFilePath) {
      logger.warn(`Accumulator exceeded ${MAX_ACCUMULATOR_BYTES} bytes — forcing flush`);
      events.push(this.#makeFileChunk(s.currentFilePath, s.contentAccumulator));
      s.contentAccumulator = '';
      s.bytesSinceLastEvent = 0;
    }

    return events;
  }

  /** Reset the parser to its initial idle state. */
  reset(): void {
    this.#state = this.#createInitialState();
  }

  /** Get the current parser state (for diagnostics). */
  get currentState(): ParserState {
    return this.#state.state;
  }

  // ─── Idle State Parsing ─────────────────────────────────────────────────

  /**
   * In idle state, scan for `<boltArtifact` tag.
   * Returns new position or -1 if partial tag saved.
   */
  #parseIdle(input: string, pos: number, events: StreamingEvent[]): number {
    const s = this.#state;

    const tagIndex = input.indexOf('<', pos);

    if (tagIndex === -1) {
      // No tags in remaining input — advance to end
      s.bytesSinceLastEvent += input.length - pos;
      return input.length;
    }

    // Check if this is the start of an artifact open tag
    const remaining = input.slice(tagIndex);

    if (remaining.startsWith(ARTIFACT_TAG_OPEN)) {
      // Find the closing `>` of the opening tag
      const tagEnd = input.indexOf('>', tagIndex);

      if (tagEnd === -1) {
        // Incomplete tag — save as partial for next chunk
        s.partialTag = remaining;
        return -1;
      }

      const fullTag = input.slice(tagIndex, tagEnd + 1);
      const artifactId =
        this.#extractAttribute(fullTag, 'identifier') ??
        this.#extractAttribute(fullTag, 'id') ??
        `artifact-${Date.now()}`;
      const artifactTitle = this.#extractAttribute(fullTag, 'title') ?? '';

      s.state = ParserState.InsideArtifact;
      s.currentArtifactId = artifactId;
      s.currentArtifactTitle = artifactTitle;

      logger.debug(`Artifact opened: id=${artifactId}, title=${artifactTitle}`);
      s.bytesSinceLastEvent = 0;

      return tagEnd + 1;
    }

    // Check for unexpected closing tags in idle state (malformed XML)
    if (remaining.startsWith(ARTIFACT_TAG_CLOSE) || remaining.startsWith(ACTION_TAG_CLOSE)) {
      logger.warn('Unexpected closing tag in idle state — ignoring');
      events.push(
        this.#makeError('UNEXPECTED_CLOSE_TAG', `Unexpected closing tag in idle state at position ${tagIndex}`, true),
      );
      s.bytesSinceLastEvent = 0;

      const closeEnd = input.indexOf('>', tagIndex);

      return closeEnd === -1 ? input.length : closeEnd + 1;
    }

    // Could be the start of a partial tag — check if ARTIFACT_TAG_OPEN could begin here
    if (ARTIFACT_TAG_OPEN.startsWith(remaining) && remaining.length < ARTIFACT_TAG_OPEN.length) {
      s.partialTag = remaining;
      return -1;
    }

    // Not a bolt tag — skip this `<` and continue
    s.bytesSinceLastEvent += tagIndex - pos + 1;

    return tagIndex + 1;
  }

  // ─── Inside Artifact Parsing ────────────────────────────────────────────

  /**
   * Inside an artifact, scan for `<boltAction ...>` or `</boltArtifact>`.
   * Returns new position or -1 if partial tag saved.
   */
  #parseInsideArtifact(input: string, pos: number, events: StreamingEvent[]): number {
    const s = this.#state;

    const tagIndex = input.indexOf('<', pos);

    if (tagIndex === -1) {
      s.bytesSinceLastEvent += input.length - pos;
      return input.length;
    }

    const remaining = input.slice(tagIndex);

    // Check for action open tag
    if (remaining.startsWith(ACTION_TAG_OPEN)) {
      const tagEnd = input.indexOf('>', tagIndex);

      if (tagEnd === -1) {
        s.partialTag = remaining;
        return -1;
      }

      const fullTag = input.slice(tagIndex, tagEnd + 1);
      const actionType = this.#extractAttribute(fullTag, 'type');
      const filePath = this.#extractAttribute(fullTag, 'filePath');

      if (actionType === 'file' && filePath) {
        s.state = ParserState.InsideAction;
        s.currentFilePath = filePath;
        s.contentAccumulator = '';

        events.push(this.#makeFileOpen(filePath));
        s.bytesSinceLastEvent = 0;

        logger.debug(`Action opened: type=file, filePath=${filePath}`);
      } else {
        // Non-file action — stay in InsideArtifact, skip tag content
        logger.debug(`Action opened: type=${actionType ?? 'unknown'} (non-file, skipping content)`);
        s.bytesSinceLastEvent = 0;
      }

      return tagEnd + 1;
    }

    // Check for artifact close tag
    if (remaining.startsWith(ARTIFACT_TAG_CLOSE)) {
      // If we're somehow still tracking a file path (missed </boltAction>), close it first
      if (s.currentFilePath) {
        logger.warn('Artifact closing with unclosed action — emitting implicit file_close');
        this.#flushAccumulator(s, events);
        events.push(this.#makeFileClose(s.currentFilePath));
        s.currentFilePath = null;
      }

      s.state = ParserState.Idle;
      s.currentArtifactId = null;
      s.currentArtifactTitle = null;
      s.bytesSinceLastEvent = 0;

      logger.debug('Artifact closed');

      return tagIndex + ARTIFACT_TAG_CLOSE.length;
    }

    // Possible partial tag at end of input
    if (
      (ACTION_TAG_OPEN.startsWith(remaining) && remaining.length < ACTION_TAG_OPEN.length) ||
      (ARTIFACT_TAG_CLOSE.startsWith(remaining) && remaining.length < ARTIFACT_TAG_CLOSE.length)
    ) {
      s.partialTag = remaining;
      return -1;
    }

    // Not a recognized tag — skip this `<`
    s.bytesSinceLastEvent += tagIndex - pos + 1;

    return tagIndex + 1;
  }

  // ─── Inside Action Parsing ──────────────────────────────────────────────

  /**
   * Inside a file action, accumulate content and watch for `</boltAction>` or
   * `</boltArtifact>` (implicit close). Emits file_chunk events incrementally.
   * Returns new position or -1 if partial tag saved.
   */
  #parseInsideAction(input: string, pos: number, events: StreamingEvent[]): number {
    const s = this.#state;

    const tagIndex = input.indexOf('<', pos);

    if (tagIndex === -1) {
      // No tags — all remaining content belongs to the current file
      const content = input.slice(pos);
      s.contentAccumulator += content;
      s.bytesSinceLastEvent += content.length;

      // Flush incrementally if accumulator is large enough
      if (s.contentAccumulator.length >= CHUNK_FLUSH_SIZE && s.currentFilePath) {
        this.#flushAccumulator(s, events);
      }

      return input.length;
    }

    // Accumulate content before the tag
    if (tagIndex > pos) {
      const content = input.slice(pos, tagIndex);
      s.contentAccumulator += content;
      s.bytesSinceLastEvent += content.length;
    }

    const remaining = input.slice(tagIndex);

    // Check for action close tag
    if (remaining.startsWith(ACTION_TAG_CLOSE)) {
      if (s.currentFilePath) {
        this.#flushAccumulator(s, events);
        events.push(this.#makeFileClose(s.currentFilePath));
        s.bytesSinceLastEvent = 0;

        logger.debug(`Action closed: filePath=${s.currentFilePath}`);
        s.currentFilePath = null;
      }

      s.state = ParserState.InsideArtifact;
      s.contentAccumulator = '';

      return tagIndex + ACTION_TAG_CLOSE.length;
    }

    // Check for artifact close tag (implicit action close — LLM omitted </boltAction>)
    if (remaining.startsWith(ARTIFACT_TAG_CLOSE)) {
      logger.warn('Artifact closing tag found inside action — implicit action close');

      if (s.currentFilePath) {
        this.#flushAccumulator(s, events);
        events.push(this.#makeFileClose(s.currentFilePath));
        s.currentFilePath = null;
      }

      s.state = ParserState.Idle;
      s.currentArtifactId = null;
      s.currentArtifactTitle = null;
      s.contentAccumulator = '';
      s.bytesSinceLastEvent = 0;

      return tagIndex + ARTIFACT_TAG_CLOSE.length;
    }

    // Check for a new action open (nested actions — malformed but recoverable)
    if (remaining.startsWith(ACTION_TAG_OPEN)) {
      const tagEnd = input.indexOf('>', tagIndex);

      if (tagEnd === -1) {
        s.partialTag = remaining;
        return -1;
      }

      // Close current action implicitly and open the new one
      logger.warn('Nested action tag detected — closing current action implicitly');

      if (s.currentFilePath) {
        this.#flushAccumulator(s, events);
        events.push(this.#makeFileClose(s.currentFilePath));
        s.bytesSinceLastEvent = 0;
      }

      const fullTag = input.slice(tagIndex, tagEnd + 1);
      const actionType = this.#extractAttribute(fullTag, 'type');
      const filePath = this.#extractAttribute(fullTag, 'filePath');

      if (actionType === 'file' && filePath) {
        s.currentFilePath = filePath;
        s.contentAccumulator = '';
        events.push(this.#makeFileOpen(filePath));
        logger.debug(`Nested action opened: type=file, filePath=${filePath}`);
      } else {
        s.state = ParserState.InsideArtifact;
        s.currentFilePath = null;
        s.contentAccumulator = '';
      }

      s.bytesSinceLastEvent = 0;

      return tagEnd + 1;
    }

    // Check for a new artifact open (nested artifact — malformed)
    if (remaining.startsWith(ARTIFACT_TAG_OPEN)) {
      logger.warn('Nested artifact tag detected — emitting error and resetting');
      events.push(this.#makeError('NESTED_ARTIFACT', 'Nested <boltArtifact> detected — resetting parser', true));

      if (s.currentFilePath) {
        this.#flushAccumulator(s, events);
        events.push(this.#makeFileClose(s.currentFilePath));
      }

      this.#forceReset(s);
      s.bytesSinceLastEvent = 0;

      // Re-parse from this position in idle state so the new artifact gets picked up
      return tagIndex;
    }

    // Possible partial closing tag at end of input
    if (
      (ACTION_TAG_CLOSE.startsWith(remaining) && remaining.length < ACTION_TAG_CLOSE.length) ||
      (ARTIFACT_TAG_CLOSE.startsWith(remaining) && remaining.length < ARTIFACT_TAG_CLOSE.length) ||
      (ACTION_TAG_OPEN.startsWith(remaining) && remaining.length < ACTION_TAG_OPEN.length) ||
      (ARTIFACT_TAG_OPEN.startsWith(remaining) && remaining.length < ARTIFACT_TAG_OPEN.length)
    ) {
      s.partialTag = remaining;
      return -1;
    }

    // Not a recognized tag — the `<` is part of file content (e.g., HTML in a file)
    s.contentAccumulator += '<';
    s.bytesSinceLastEvent += 1;

    return tagIndex + 1;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** Flush the content accumulator as a file_chunk event. */
  #flushAccumulator(s: ParserInternalState, events: StreamingEvent[]): void {
    if (s.contentAccumulator.length > 0 && s.currentFilePath) {
      events.push(this.#makeFileChunk(s.currentFilePath, s.contentAccumulator));
      s.contentAccumulator = '';
      s.bytesSinceLastEvent = 0;
    }
  }

  /** Force-reset parser to idle state (error recovery). */
  #forceReset(s: ParserInternalState): void {
    s.state = ParserState.Idle;
    s.partialTag = '';
    s.currentArtifactId = null;
    s.currentArtifactTitle = null;
    s.currentFilePath = null;
    s.contentAccumulator = '';
    s.bytesSinceLastEvent = 0;
  }

  /** Create clean initial state. */
  #createInitialState(): ParserInternalState {
    return {
      state: ParserState.Idle,
      partialTag: '',
      currentArtifactId: null,
      currentArtifactTitle: null,
      currentFilePath: null,
      contentAccumulator: '',
      bytesSinceLastEvent: 0,
    };
  }

  /**
   * Extract an XML attribute value from a tag string.
   * Supports both single and double quotes.
   */
  #extractAttribute(tag: string, name: string): string | undefined {
    const match = tag.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
    return match ? match[1] : undefined;
  }

  // ─── Event Factories ────────────────────────────────────────────────────

  #makeFileOpen(filePath: string): FileOpenEvent {
    return {
      type: 'file_open',
      timestamp: new Date().toISOString(),
      filePath,
      artifactId: this.#state.currentArtifactId ?? undefined,
    };
  }

  #makeFileChunk(filePath: string, content: string): FileChunkEvent {
    return {
      type: 'file_chunk',
      timestamp: new Date().toISOString(),
      filePath,
      content,
      format: 'full_content',
      artifactId: this.#state.currentArtifactId ?? undefined,
    };
  }

  #makeFileClose(filePath: string): FileCloseEvent {
    return {
      type: 'file_close',
      timestamp: new Date().toISOString(),
      filePath,
      artifactId: this.#state.currentArtifactId ?? undefined,
    };
  }

  #makePhaseChange(phase: string): PhaseChangeEvent {
    return {
      type: 'phase_change',
      timestamp: new Date().toISOString(),
      phase,
      artifactId: this.#state.currentArtifactId ?? undefined,
    };
  }

  #makeError(code: string, message: string, recoverable: boolean): ErrorEvent {
    return {
      type: 'error',
      timestamp: new Date().toISOString(),
      code,
      message,
      recoverable,
      artifactId: this.#state.currentArtifactId ?? undefined,
    };
  }
}
