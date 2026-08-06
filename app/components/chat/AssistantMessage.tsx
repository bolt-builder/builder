import { memo, Fragment, useState } from 'react';
import { Markdown } from './Markdown';
import type { JSONValue, Message } from 'ai';
import Popover from '~/components/ui/Popover';
import { workbenchStore } from '~/lib/stores/workbench';
import { WORK_DIR } from '~/utils/constants';
import WithTooltip from '~/components/ui/Tooltip';
import type { ProviderInfo } from '~/types/model';
import type {
  TextUIPart,
  ReasoningUIPart,
  ToolInvocationUIPart,
  SourceUIPart,
  FileUIPart,
  StepStartUIPart,
} from '@ai-sdk/ui-utils';
import { ToolInvocations } from './ToolInvocations';
import type { ToolCallAnnotation } from '~/types/context';

/**
 * Collapsible block that displays AI reasoning / thinking content.
 * Renders as a styled <details> element with a brain icon header.
 */
const ThinkingBlock = memo(({ reasoningParts }: { reasoningParts: ReasoningUIPart[] }) => {
  const [isOpen, setIsOpen] = useState(false);
  const combinedText = reasoningParts.map((p) => p.reasoning).join('\n');

  if (!combinedText.trim()) {
    return null;
  }

  return (
    <div className="mb-3 rounded-lg border border-bolt-elements-borderColor overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-bolt-elements-textSecondary bg-bolt-elements-background-depth-2 hover:bg-bolt-elements-background-depth-3 transition-colors"
      >
        <div className="i-ph:brain w-4 h-4 text-bolt-elements-item-contentAccent" />
        <span>Thinking</span>
        <div
          className={`i-ph:caret-right w-3 h-3 ml-auto transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
        />
      </button>
      {isOpen && (
        <div className="px-3 py-2 text-xs text-bolt-elements-textSecondary bg-bolt-elements-background-depth-1 border-t border-bolt-elements-borderColor max-h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed">
          {combinedText}
        </div>
      )}
    </div>
  );
});

interface AssistantMessageProps {
  content: string;
  annotations?: JSONValue[];
  messageId?: string;
  onRewind?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  append?: (message: Message) => void;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
  model?: string;
  provider?: ProviderInfo;
  parts:
    (TextUIPart | ReasoningUIPart | ToolInvocationUIPart | SourceUIPart | FileUIPart | StepStartUIPart)[] | undefined;
  addToolResult: ({ toolCallId, result }: { toolCallId: string; result: unknown }) => void;
}

const COMPLETE_ARTIFACT_BLOCK_RE = /<boltArtifact[^>]*>[\s\S]*?<\/boltArtifact>/g;
const COMPLETE_ACTION_BLOCK_RE = /<boltAction[^>]*>[\s\S]*?<\/boltAction>/g;
const UNCLOSED_ARTIFACT_RE = /<boltArtifact[^>]*>[\s\S]*$/;
const UNCLOSED_ACTION_RE = /<boltAction[^>]*>[\s\S]*$/;
const LEFTOVER_TAG_RE = /<\/?bolt(?:Artifact|Action)[^>]*>/g;
const PARTIAL_BOLT_TAG_RE = /<bolt[A-Za-z]*(?:\s[^>]*)?$/;

/** Matches complete or partial `</assistant>` / `<assistant>` XML tags that LLMs sometimes emit */
const ASSISTANT_TAG_RE = /<\/?assist(?:ant)?>|<\/assis(?:t(?:a(?:n(?:t)?)?)?)?\s*$/g;

/** Matches `<chain_of_thought>...</chain_of_thought>` blocks and leftover open/close tags (Google Gemini) */
const CHAIN_OF_THOUGHT_BLOCK_RE = /<chain_of_thought>[\s\S]*?<\/chain_of_thought>/g;
const CHAIN_OF_THOUGHT_TAG_RE = /<\/?chain_of_thought\s*\/?>/g;

/** Matches complete fenced code blocks that leaked outside artifact wrappers */
const LEAKED_CODE_BLOCK_RE = /```[\w]*\n[\s\S]*?```/g;

/** Matches unclosed fenced code blocks still being streamed */
const UNCLOSED_CODE_BLOCK_RE = /```[\w]*\n[\s\S]*$/;

/**
 * Strip raw artifact/action markup — including file CONTENT — that leaks
 * through the parser during streaming.
 *
 * 1. Complete `<boltArtifact>` blocks (wrapper + all actions + content)
 * 2. Complete `<boltAction>` blocks (handles cases where the parser
 *    already consumed the artifact wrapper but left action tags + code)
 * 3. Everything after an unclosed `<boltArtifact` or `<boltAction`
 *    tag (content still streaming)
 * 4. Leftover individual open/close tags
 * 5. Partial `<bolt...` tags mid-stream (e.g. `<boltArt`)
 *
 * Also strips stray `</assistant>` fragments and `<chain_of_thought>` blocks.
 */
function stripRawArtifactTags(text: string): string {
  let result = text;

  if (result.includes('<bolt')) {
    result = result.replace(COMPLETE_ARTIFACT_BLOCK_RE, '');
    result = result.replace(COMPLETE_ACTION_BLOCK_RE, '');
    result = result.replace(UNCLOSED_ARTIFACT_RE, '');
    result = result.replace(UNCLOSED_ACTION_RE, '');
    result = result.replace(LEFTOVER_TAG_RE, '');
    result = result.replace(PARTIAL_BOLT_TAG_RE, '');
  }

  if (result.includes('assis') || result.includes('Assis')) {
    result = result.replace(ASSISTANT_TAG_RE, '');
  }

  if (result.includes('chain_of_thought')) {
    result = result.replace(CHAIN_OF_THOUGHT_BLOCK_RE, '').replace(CHAIN_OF_THOUGHT_TAG_RE, '');
  }

  /*
   * Strip leaked code blocks when artifacts are present — code content
   * should only appear inside artifact actions, never in chat text
   */
  if (result.includes('__boltArtifact__')) {
    result = result.replace(LEAKED_CODE_BLOCK_RE, '');
    result = result.replace(UNCLOSED_CODE_BLOCK_RE, '');
  }

  return result;
}

function openArtifactInWorkbench(filePath: string) {
  filePath = normalizedFilePath(filePath);

  if (workbenchStore.currentView.get() !== 'code') {
    workbenchStore.currentView.set('code');
  }

  workbenchStore.setSelectedFile(`${WORK_DIR}/${filePath}`);
}

function normalizedFilePath(path: string) {
  let normalizedPath = path;

  if (normalizedPath.startsWith(WORK_DIR)) {
    normalizedPath = path.replace(WORK_DIR, '');
  }

  if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.slice(1);
  }

  return normalizedPath;
}

export const AssistantMessage = memo(
  ({
    content,
    annotations,
    messageId,
    onRewind,
    onFork,
    append,
    chatMode,
    setChatMode,
    model,
    provider,
    parts,
    addToolResult,
  }: AssistantMessageProps) => {
    const filteredAnnotations = (annotations?.filter(
      (annotation: JSONValue) =>
        annotation && typeof annotation === 'object' && Object.keys(annotation).includes('type'),
    ) || []) as Array<{ type: string; value?: unknown; summary?: string; files?: string[]; [key: string]: unknown }>;

    let chatSummary: string | undefined = undefined;

    if (filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')) {
      chatSummary = filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')?.summary;
    }

    let codeContext: string[] | undefined = undefined;

    if (filteredAnnotations.find((annotation) => annotation.type === 'codeContext')) {
      codeContext = filteredAnnotations.find((annotation) => annotation.type === 'codeContext')?.files;
    }

    const usage = filteredAnnotations.find((annotation) => annotation.type === 'usage')?.value as
      { completionTokens: number; promptTokens: number; totalTokens: number } | undefined;

    const toolInvocations = parts?.filter((part) => part.type === 'tool-invocation');
    const reasoningParts = parts?.filter((part) => part.type === 'reasoning') as ReasoningUIPart[] | undefined;
    const toolCallAnnotations = filteredAnnotations.filter(
      (annotation) => annotation.type === 'toolCall',
    ) as ToolCallAnnotation[];

    return (
      <div className="overflow-hidden w-full">
        {/* Assistant Header - Blink style */}
        <div className="flex items-center gap-2 mb-3">
          <div className="w-6 h-6 rounded-full bg-bolt-elements-bg-depth-3 border border-bolt-elements-borderColor flex items-center justify-center">
            <span className="text-xs font-bold text-bolt-elements-textPrimary">D</span>
          </div>
          <span className="text-sm font-medium text-bolt-elements-textSecondary">Bolt</span>
          {(codeContext || chatSummary) && (
            <Popover
              side="right"
              align="start"
              trigger={
                <div className="i-ph:info text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors cursor-pointer" />
              }
            >
              {chatSummary && (
                <div className="max-w-chat">
                  <div className="summary max-h-96 flex flex-col">
                    <h2 className="border border-bolt-elements-borderColor rounded-md p4">Summary</h2>
                    <div style={{ zoom: 0.7 }} className="overflow-y-auto m4">
                      <Markdown>{chatSummary}</Markdown>
                    </div>
                  </div>
                  {codeContext && (
                    <div className="code-context flex flex-col p4 border border-bolt-elements-borderColor rounded-md">
                      <h2>Context</h2>
                      <div className="flex gap-4 mt-4 bolt" style={{ zoom: 0.6 }}>
                        {codeContext.map((x, i) => {
                          const normalized = normalizedFilePath(x);
                          return (
                            <Fragment key={`${normalized}-${i}`}>
                              <code
                                className="bg-bolt-elements-artifacts-inlineCode-background text-bolt-elements-artifacts-inlineCode-text px-1.5 py-1 rounded-md text-bolt-elements-item-contentAccent hover:underline cursor-pointer"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openArtifactInWorkbench(normalized);
                                }}
                              >
                                {normalized}
                              </code>
                            </Fragment>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="context"></div>
            </Popover>
          )}
          <div className="flex-1" />
          {usage && (
            <div className="text-xs text-bolt-elements-textTertiary">{usage.totalTokens.toLocaleString()} tokens</div>
          )}
          {(onRewind || onFork) && messageId && (
            <div className="flex gap-1.5">
              {onRewind && (
                <WithTooltip tooltip="Restore checkpoint (chat + code)">
                  <button
                    onClick={() => onRewind(messageId)}
                    key="i-ph:arrow-u-up-left"
                    aria-label="Restore checkpoint (chat + code)"
                    className="i-ph:arrow-u-up-left text-lg text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary transition-colors"
                  />
                </WithTooltip>
              )}
              {onFork && (
                <WithTooltip tooltip="Fork chat from this message">
                  <button
                    onClick={() => onFork(messageId)}
                    key="i-ph:git-fork"
                    className="i-ph:git-fork text-lg text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary transition-colors"
                  />
                </WithTooltip>
              )}
            </div>
          )}
        </div>

        {/* Reasoning / Thinking Display */}
        {reasoningParts && reasoningParts.length > 0 && <ThinkingBlock reasoningParts={reasoningParts} />}

        {/* Message Content */}
        <div className="text-bolt-elements-textPrimary text-sm leading-relaxed">
          <Markdown
            append={append}
            chatMode={chatMode}
            setChatMode={setChatMode}
            model={model}
            provider={provider}
            html
          >
            {stripRawArtifactTags(content)}
          </Markdown>
        </div>

        {toolInvocations && toolInvocations.length > 0 && (
          <div className="mt-3">
            <ToolInvocations
              toolInvocations={toolInvocations}
              toolCallAnnotations={toolCallAnnotations}
              addToolResult={addToolResult}
            />
          </div>
        )}
      </div>
    );
  },
);
