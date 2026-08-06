import type { ToolInvocationUIPart } from '@ai-sdk/ui-utils';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  getSharedHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
} from '~/utils/shiki-highlighter';
import DOMPurify from 'dompurify';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { cn } from '~/utils/cn';
import {
  TOOL_EXECUTION_APPROVAL,
  TOOL_EXECUTION_DENIED,
  TOOL_EXECUTION_ERROR,
  TOOL_NO_EXECUTE_FUNCTION,
} from '~/utils/constants';
import { cubicEasingFn } from '~/utils/easings';
import { logger } from '~/utils/logger';
import { themeStore, type Theme } from '~/lib/stores/theme';
import { useStore } from '@nanostores/react';
import { mcpStore } from '~/lib/stores/mcp';
import { agentModeStore } from '~/lib/stores/agentMode';
import type { ToolCallAnnotation } from '~/types/context';
import { shouldAutoApproveAgentTool } from '~/utils/agentToolApproval';

/**
 * NOTE: Primary auto-approval for agent tools happens in Chat.client.tsx via
 * onToolCall (which works with maxSteps for automatic re-submission).
 * This component provides fallback UI auto-approval for MCP tools and
 * any agent tools that slip through.
 */

/**
 * DOMPurify configuration for sanitizing Shiki syntax-highlighted HTML output.
 * Restricts output to only the HTML elements and attributes that Shiki produces.
 * This provides defense-in-depth against XSS even though Shiki escapes code content.
 *
 * SECURITY NOTE: Tool invocation data (args and results) comes from LLM-generated
 * content and MCP server responses, which could be controlled by malicious actors.
 * Sanitization is critical here.
 */
const SHIKI_PURIFY_CONFIG = {
  ALLOWED_TAGS: ['pre', 'code', 'span'],
  ALLOWED_ATTR: ['class', 'style', 'tabindex'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

const jsonHighlighter: HighlighterGeneric<BundledLanguage, BundledTheme> =
  import.meta.hot?.data.jsonHighlighter ?? (await getSharedHighlighter());

if (import.meta.hot) {
  import.meta.hot.data.jsonHighlighter = jsonHighlighter;
}

/**
 * Extracts human-readable text content from an MCP tool result.
 *
 * MCP results follow the protocol format:
 *   { content: [{ type: 'text', text: '...' }], isError: false, structuredContent: { result: '...' } }
 *
 * This function extracts the actual text, avoiding raw JSON display.
 * Returns null if no readable text is found (pure structured data).
 */
export function extractMcpResultText(result: unknown): { text: string | null; isError: boolean } {
  // String results (e.g. TOOL_EXECUTION_DENIED)
  if (typeof result === 'string') {
    return { text: result, isError: false };
  }

  if (typeof result !== 'object' || result === null) {
    return { text: null, isError: false };
  }

  const obj = result as Record<string, unknown>;
  const isError = obj.isError === true;

  // MCP protocol: content[].text
  if (Array.isArray(obj.content)) {
    const textParts = (obj.content as Array<Record<string, unknown>>)
      .filter((item) => item?.type === 'text' && typeof item?.text === 'string')
      .map((item) => item.text as string);

    if (textParts.length > 0) {
      return { text: textParts.join('\n\n'), isError };
    }
  }

  // structuredContent.result (string)
  if (
    typeof obj.structuredContent === 'object' &&
    obj.structuredContent !== null &&
    typeof (obj.structuredContent as Record<string, unknown>).result === 'string'
  ) {
    return { text: (obj.structuredContent as Record<string, unknown>).result as string, isError };
  }

  // Direct result field (string)
  if (typeof obj.result === 'string') {
    return { text: obj.result, isError };
  }

  // No text found — will fall through to raw JSON display
  return { text: null, isError };
}

/** View mode for tool result display */
type ResultViewMode = 'formatted' | 'raw';

interface JsonCodeBlockProps {
  className?: string;
  code: string;
  theme: Theme;
}

function JsonCodeBlock({ className, code, theme }: JsonCodeBlockProps) {
  let formattedCode = code;

  try {
    if (typeof formattedCode === 'object') {
      formattedCode = JSON.stringify(formattedCode, null, 2);
    } else if (typeof formattedCode === 'string') {
      // Attempt to parse and re-stringify for formatting
      try {
        const parsed = JSON.parse(formattedCode);
        formattedCode = JSON.stringify(parsed, null, 2);
      } catch {
        // Leave as is if not JSON
      }
    }
  } catch (e) {
    // If parsing fails, keep original code
    logger.error('Failed to parse JSON', { error: e });
  }

  // Generate syntax-highlighted HTML from Shiki
  const rawHtml = jsonHighlighter.codeToHtml(formattedCode, {
    lang: 'json',
    theme: theme === 'dark' ? 'dark-plus' : 'light-plus',
  });

  /*
   * SECURITY: Sanitize HTML output to prevent XSS attacks.
   * Tool invocation data (args/results) comes from LLM and MCP servers,
   * which could contain malicious content if a user connects to an untrusted MCP server.
   */
  const sanitizedHtml = DOMPurify.sanitize(rawHtml, SHIKI_PURIFY_CONFIG);

  return (
    <div
      className={cn('text-xs rounded-md overflow-hidden mcp-tool-invocation-code', className)}
      dangerouslySetInnerHTML={{
        __html: sanitizedHtml,
      }}
      style={{
        padding: '0',
        margin: '0',
      }}
    ></div>
  );
}

interface ToolInvocationsProps {
  toolInvocations: ToolInvocationUIPart[];
  toolCallAnnotations: ToolCallAnnotation[];
  addToolResult: ({ toolCallId, result }: { toolCallId: string; result: unknown }) => void;
}

export const ToolInvocations = memo(({ toolInvocations, toolCallAnnotations, addToolResult }: ToolInvocationsProps) => {
  const theme = useStore(themeStore);
  const [showDetails, setShowDetails] = useState(false);

  const toggleDetails = () => {
    setShowDetails((prev) => !prev);
  };

  const toolCalls = useMemo(
    () => toolInvocations.filter((inv) => inv.toolInvocation.state === 'call'),
    [toolInvocations],
  );

  const toolResults = useMemo(
    () => toolInvocations.filter((inv) => inv.toolInvocation.state === 'result'),
    [toolInvocations],
  );

  const hasToolCalls = toolCalls.length > 0;
  const hasToolResults = toolResults.length > 0;

  if (!hasToolCalls && !hasToolResults) {
    return null;
  }

  return (
    <div className="tool-invocation border border-bolt-elements-borderColor flex flex-col overflow-hidden rounded-lg w-full transition-border duration-150">
      <div className="flex">
        <button
          className="flex items-stretch bg-bolt-elements-background-depth-2 hover:bg-bolt-elements-artifacts-backgroundHover w-full overflow-hidden"
          onClick={toggleDetails}
          aria-label={showDetails ? 'Collapse details' : 'Expand details'}
        >
          <div className="p-2.5">
            <div className="i-ph:wrench text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"></div>
          </div>
          <div className="p-2.5 w-full text-left">
            <div className="w-full text-bolt-elements-textPrimary font-medium leading-5 text-sm">
              Tool Invocations{' '}
              {hasToolResults && (
                <span className="w-full w-full text-bolt-elements-textSecondary text-xs mt-0.5">
                  ({toolResults.length} tool{hasToolResults ? 's' : ''} used)
                </span>
              )}
            </div>
          </div>
        </button>
        <AnimatePresence>
          {hasToolResults && (
            <motion.button
              initial={{ width: 0 }}
              animate={{ width: 'auto' }}
              exit={{ width: 0 }}
              transition={{ duration: 0.15, ease: cubicEasingFn }}
              className="bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover"
              onClick={toggleDetails}
            >
              <div className="p-2">
                <div
                  className={`${showDetails ? 'i-ph:caret-up-bold' : 'i-ph:caret-down-bold'} text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors`}
                ></div>
              </div>
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {hasToolCalls && (
          <motion.div
            key="tool-calls"
            className="details"
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: '0px' }}
            transition={{ duration: 0.15 }}
          >
            <div className="bg-bolt-elements-artifacts-borderColor h-[1px]" />

            <div className="px-3 py-3 text-left bg-bolt-elements-background-depth-2">
              <ToolCallsList
                toolInvocations={toolCalls}
                toolCallAnnotations={toolCallAnnotations}
                addToolResult={addToolResult}
                theme={theme}
              />
            </div>
          </motion.div>
        )}

        {hasToolResults && showDetails && (
          <motion.div
            key="tool-results"
            className="details"
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: '0px' }}
            transition={{ duration: 0.15 }}
          >
            <div className="bg-bolt-elements-artifacts-borderColor h-[1px]" />

            <div className="p-5 text-left bg-bolt-elements-actions-background">
              <ToolResultsList toolInvocations={toolResults} toolCallAnnotations={toolCallAnnotations} theme={theme} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

const toolVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

interface ToolResultsListProps {
  toolInvocations: ToolInvocationUIPart[];
  toolCallAnnotations: ToolCallAnnotation[];
  theme: Theme;
}

/** Maximum collapsed height for long tool results (px) */
const RESULT_COLLAPSED_MAX_HEIGHT = 200;

/** Line count threshold before showing collapse/expand controls */
const RESULT_LINE_THRESHOLD = 10;

interface ToolResultItemProps {
  tool: ToolInvocationUIPart;
  annotation: ToolCallAnnotation | undefined;
  theme: Theme;
}

/**
 * Formatted markdown renderer for extracted MCP tool result text.
 * Lightweight — uses remarkGfm for tables/lists and rehypeSanitize for security.
 */
const FormattedResultContent = memo(({ text, theme }: { text: string; theme: Theme }) => {
  return (
    <div
      className={cn('prose prose-sm max-w-none', theme === 'dark' ? 'prose-invert' : '', 'text-xs leading-relaxed')}
      style={{
        color: theme === 'dark' ? '#e5e7eb' : '#1f2937',
      }}
    >
      <ReactMarkdown key={text.length} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Individual tool result display with:
 * - Formatted markdown view (default when text content is extractable)
 * - Raw JSON view toggle
 * - Collapsible long outputs with line count
 * - Copy-to-clipboard
 */
const ToolResultItem = memo(({ tool, annotation, theme }: ToolResultItemProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const resultContainerRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const { toolInvocation } = tool;

  // Extract readable text from MCP result
  const extracted = useMemo(() => {
    if (toolInvocation.state !== 'result') {
      return { text: null, isError: false };
    }

    return extractMcpResultText(toolInvocation.result);
  }, [toolInvocation]);

  const hasFormattedContent = extracted.text !== null && !extracted.isError;

  // Default to formatted view when text is available, raw otherwise
  const [viewMode, setViewMode] = useState<ResultViewMode>(hasFormattedContent ? 'formatted' : 'raw');

  const resultStr = useMemo(() => {
    if (toolInvocation.state !== 'result') {
      return '';
    }

    try {
      return JSON.stringify(toolInvocation.result, null, 2);
    } catch {
      return String(toolInvocation.result);
    }
  }, [toolInvocation]);

  const lineCount = useMemo(() => resultStr.split('\n').length, [resultStr]);
  const isLongResult = lineCount > RESULT_LINE_THRESHOLD;
  const isFormattedLong = (extracted.text?.split('\n').length ?? 0) > RESULT_LINE_THRESHOLD;

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // Detect whether the result container overflows the collapsed max-height
  useEffect(() => {
    if (resultContainerRef.current) {
      const needs = resultContainerRef.current.scrollHeight > RESULT_COLLAPSED_MAX_HEIGHT;
      setIsOverflowing(needs);
    }
  }, [resultStr, viewMode, isExpanded]);

  // Guard — parent already filters for results but keeps TS happy
  if (toolInvocation.state !== 'result') {
    return null;
  }

  const { toolName } = toolInvocation;

  const isErrorResult = [TOOL_NO_EXECUTE_FUNCTION, TOOL_EXECUTION_DENIED, TOOL_EXECUTION_ERROR].includes(
    toolInvocation.result,
  );

  const shouldCollapse = viewMode === 'raw' ? isLongResult : isFormattedLong;

  const handleCopy = async () => {
    try {
      const textToCopy = viewMode === 'formatted' && extracted.text ? extracted.text : resultStr;
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);

      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }

      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      logger.error('Failed to copy result to clipboard');
    }
  };

  return (
    <motion.li
      variants={toolVariants}
      initial="hidden"
      animate="visible"
      transition={{ duration: 0.2, ease: cubicEasingFn }}
    >
      <div className="flex items-center gap-1.5 text-xs mb-1">
        {isErrorResult ? (
          <div className="text-lg text-bolt-elements-icon-error">
            <div className="i-ph:x"></div>
          </div>
        ) : (
          <div className="text-lg text-bolt-elements-icon-success">
            <div className="i-ph:check"></div>
          </div>
        )}
        <div className="text-bolt-elements-textSecondary text-xs">Server:</div>
        <div className="text-bolt-elements-textPrimary font-semibold">{annotation?.serverName}</div>
      </div>

      <div className="ml-6 mb-2">
        <div className="text-bolt-elements-textSecondary text-xs mb-1">
          Tool: <span className="text-bolt-elements-textPrimary font-semibold">{toolName}</span>
        </div>
        <div className="text-bolt-elements-textSecondary text-xs mb-1">
          Description:{' '}
          <span className="text-bolt-elements-textPrimary font-semibold">{annotation?.toolDescription}</span>
        </div>
        <div className="text-bolt-elements-textSecondary text-xs mb-1">Parameters:</div>
        <div className="bg-bolt-elements-bg-depth-1 p-3 rounded-md">
          <JsonCodeBlock className="mb-0" code={JSON.stringify(toolInvocation.args)} theme={theme} />
        </div>

        {/* Result header with view toggle, line count, and copy button */}
        <div className="flex items-center justify-between mt-3 mb-1">
          <div className="flex items-center gap-2">
            <div className="text-bolt-elements-textSecondary text-xs">
              Result
              {viewMode === 'raw' && lineCount > 1 && (
                <span className="ml-1.5 text-bolt-elements-textTertiary">({lineCount} lines)</span>
              )}
            </div>

            {/* View mode toggle — only show when formatted content is available */}
            {hasFormattedContent && (
              <div className="flex items-center rounded-md overflow-hidden border border-bolt-elements-borderColor">
                <button
                  onClick={() => {
                    setViewMode('formatted');
                    setIsExpanded(false);
                  }}
                  className={cn(
                    'px-2 py-0.5 text-xs transition-colors',
                    viewMode === 'formatted'
                      ? 'bg-accent-500/15 text-accent-500'
                      : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                  )}
                  title="Show formatted content"
                >
                  <div className="i-ph:article" />
                </button>
                <button
                  onClick={() => {
                    setViewMode('raw');
                    setIsExpanded(false);
                  }}
                  className={cn(
                    'px-2 py-0.5 text-xs transition-colors',
                    viewMode === 'raw'
                      ? 'bg-accent-500/15 text-accent-500'
                      : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                  )}
                  title="Show raw JSON"
                >
                  <div className="i-ph:code" />
                </button>
              </div>
            )}
          </div>

          <button
            onClick={handleCopy}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 text-xs rounded transition-colors',
              copied ? 'text-green-400' : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
            )}
            title="Copy result to clipboard"
          >
            <div className={copied ? 'i-ph:check' : 'i-ph:copy'} />
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {/* Result content with collapse/expand for long outputs */}
        <div className="bg-bolt-elements-bg-depth-1 p-3 rounded-md relative">
          <div
            ref={resultContainerRef}
            className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
            style={{
              maxHeight: !isExpanded && shouldCollapse ? `${RESULT_COLLAPSED_MAX_HEIGHT}px` : 'none',
            }}
          >
            {viewMode === 'formatted' && extracted.text ? (
              <FormattedResultContent text={extracted.text} theme={theme} />
            ) : (
              <JsonCodeBlock className="mb-0" code={resultStr} theme={theme} />
            )}
          </div>

          {/* Fade overlay when collapsed and content overflows */}
          {shouldCollapse && !isExpanded && isOverflowing && (
            <div
              className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none rounded-b-md"
              style={{
                background:
                  theme === 'dark'
                    ? 'linear-gradient(to bottom, transparent, #1a1a1a)'
                    : 'linear-gradient(to bottom, transparent, #f5f5f5)',
              }}
            />
          )}

          {/* Show more / Show less toggle */}
          {shouldCollapse && (
            <button
              onClick={() => setIsExpanded((prev) => !prev)}
              className="w-full mt-1 py-1 text-xs text-center text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary transition-colors"
            >
              {isExpanded ? (
                <span className="flex items-center justify-center gap-1">
                  <div className="i-ph:caret-up text-sm" />
                  Show less
                </span>
              ) : (
                <span className="flex items-center justify-center gap-1">
                  <div className="i-ph:caret-down text-sm" />
                  Show more
                </span>
              )}
            </button>
          )}
        </div>
      </div>
    </motion.li>
  );
});

const ToolResultsList = memo(({ toolInvocations, toolCallAnnotations, theme }: ToolResultsListProps) => {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <ul className="list-none space-y-4">
        {toolInvocations.map((tool, index) => {
          const annotation = toolCallAnnotations.find((a) => a.toolCallId === tool.toolInvocation.toolCallId);
          return <ToolResultItem key={index} tool={tool} annotation={annotation} theme={theme} />;
        })}
      </ul>
    </motion.div>
  );
});

interface ToolCallsListProps {
  toolInvocations: ToolInvocationUIPart[];
  toolCallAnnotations: ToolCallAnnotation[];
  addToolResult: ({ toolCallId, result }: { toolCallId: string; result: unknown }) => void;
  theme: Theme;
}

const ToolCallsList = memo(({ toolInvocations, toolCallAnnotations, addToolResult }: ToolCallsListProps) => {
  const [expanded, setExpanded] = useState<{ [id: string]: boolean }>({});
  const autoApprovedRef = useRef<Set<string>>(new Set());
  const { settings } = useStore(mcpStore);
  const autoApproveServers = settings.autoApproveServers || [];
  const { settings: agentSettings } = useStore(agentModeStore);

  // OS detection for shortcut display
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  /**
   * Execute an agent tool on the client side and send the actual result via addToolResult.
   * For MCP tools, send 'Yes, approved.' for server-side execution (MCPService handles it).
   * This avoids the SSR runtime hang where `await runtime` never resolves on the server.
   */
  const handleApprove = useCallback(
    async (toolCallId: string) => {
      const inv = toolInvocations.find((i) => i.toolInvocation.toolCallId === toolCallId);

      if (!inv) {
        return;
      }

      const { toolName, args } = inv.toolInvocation;
      const annotation = toolCallAnnotations.find((a) => a.toolCallId === toolCallId);
      const serverName = annotation?.serverName ?? '';

      if (serverName === 'bolt-agent') {
        // Execute agent tools on the CLIENT to avoid SSR runtime hang
        try {
          const { executeAgentTool } = await import('~/lib/services/agentToolsService');
          const result = await executeAgentTool(toolName, args as Record<string, unknown>);
          logger.debug(`Tool ${toolName} executed on client:`, result);
          addToolResult({ toolCallId, result });
        } catch (error) {
          logger.error(`Failed to execute agent tool ${toolName}:`, error);
          addToolResult({
            toolCallId,
            result: { error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}` },
          });
        }
      } else {
        // MCP tools: send approval for server-side execution (MCPService works on server)
        addToolResult({ toolCallId, result: TOOL_EXECUTION_APPROVAL.APPROVE });
      }
    },
    [toolInvocations, toolCallAnnotations, addToolResult],
  );

  useEffect(() => {
    const expandedState: { [id: string]: boolean } = {};
    toolInvocations.forEach((inv) => {
      if (inv.toolInvocation.state === 'call') {
        expandedState[inv.toolInvocation.toolCallId] = true;
      }
    });
    setExpanded(expandedState);
  }, [toolInvocations]);

  /*
   * Auto-approve tool calls for MCP servers in the auto-approve list.
   * NOTE: Agent tool auto-approval is primarily handled by onToolCall in Chat.client.tsx.
   * This fallback covers MCP tools from auto-approve servers.
   */
  useEffect(() => {
    toolInvocations.forEach((inv) => {
      if (inv.toolInvocation.state !== 'call') {
        return;
      }

      const { toolCallId, toolName } = inv.toolInvocation;

      // Skip if already auto-approved to prevent infinite loops
      if (autoApprovedRef.current.has(toolCallId)) {
        return;
      }

      const annotation = toolCallAnnotations.find((a) => a.toolCallId === toolCallId);
      const serverName = annotation?.serverName ?? '';

      // Check MCP server auto-approve list
      const isMcpAutoApproved = autoApproveServers.includes(serverName);

      // Check agent tool auto-approve settings (fallback for edge cases)
      const isAgentAutoApproved = serverName === 'bolt-agent' && shouldAutoApproveAgentTool(toolName, agentSettings);

      if (!isMcpAutoApproved && !isAgentAutoApproved) {
        return;
      }

      autoApprovedRef.current.add(toolCallId);

      logger.debug(`Auto-approving tool "${toolName}" from server "${serverName}"`);
      handleApprove(toolCallId);
    });
  }, [toolInvocations, toolCallAnnotations, handleApprove, autoApproveServers, agentSettings]);

  // Keyboard shortcut logic
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if focus is in an input/textarea/contenteditable
      const active = document.activeElement as HTMLElement | null;

      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        return;
      }

      if (Object.keys(expanded).length === 0) {
        return;
      }

      const openId = Object.keys(expanded).find((id) => expanded[id]);

      if (!openId) {
        return;
      }

      // Cancel: Cmd/Ctrl + Backspace
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'Backspace') {
        e.preventDefault();
        addToolResult({
          toolCallId: openId,
          result: TOOL_EXECUTION_APPROVAL.REJECT,
        });
      }

      // Run tool: Cmd/Ctrl + Enter
      if ((isMac ? e.metaKey : e.ctrlKey) && (e.key === 'Enter' || e.key === 'Return')) {
        e.preventDefault();
        handleApprove(openId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [expanded, handleApprove, isMac]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <ul className="list-none space-y-4">
        {toolInvocations.map((tool, index) => {
          const toolCallState = tool.toolInvocation.state;

          if (toolCallState !== 'call') {
            return null;
          }

          const { toolName, toolCallId } = tool.toolInvocation;
          const annotation = toolCallAnnotations.find((annotation) => annotation.toolCallId === toolCallId);
          const serverName = annotation?.serverName ?? '';
          const isAutoApproving =
            autoApproveServers.includes(serverName) ||
            (serverName === 'bolt-agent' && shouldAutoApproveAgentTool(toolName, agentSettings));

          return (
            <motion.li
              key={index}
              variants={toolVariants}
              initial="hidden"
              animate="visible"
              transition={{ duration: 0.2, ease: cubicEasingFn }}
            >
              <div className="bg-bolt-elements-background-depth-3 rounded-lg p-2">
                <div key={toolCallId} className="flex gap-1">
                  <div className="flex flex-col items-center ">
                    <span className="mr-auto font-light font-normal text-md text-bolt-elements-textPrimary rounded-md">
                      {toolName}
                    </span>
                    <span className="text-xs text-bolt-elements-textSecondary font-light break-words max-w-64">
                      {annotation?.toolDescription}
                    </span>
                  </div>
                  <div className="flex items-center justify-end gap-2 ml-auto">
                    {isAutoApproving ? (
                      <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-green-400">
                        <div className="i-svg-spinners:90-ring-with-bg w-3 h-3 animate-spin" />
                        Auto-approving...
                      </div>
                    ) : (
                      <>
                        <button
                          className={cn(
                            'h-10 px-2.5 py-1.5 rounded-lg text-xs h-auto',
                            'bg-transparent',
                            'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                            'transition-all duration-200',
                            'flex items-center gap-2',
                          )}
                          onClick={() =>
                            addToolResult({
                              toolCallId,
                              result: TOOL_EXECUTION_APPROVAL.REJECT,
                            })
                          }
                        >
                          Cancel <span className="opacity-70 text-xs ml-1">{isMac ? '⌘⌫' : 'Ctrl+Backspace'}</span>
                        </button>
                        <button
                          className={cn(
                            'h-10 inline-flex items-center gap-2 px-3 py-1.5 text-xs font-normal rounded-lg transition-colors',
                            'bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor',
                            'text-accent-500 hover:text-bolt-elements-textPrimary',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                          )}
                          onClick={() => handleApprove(toolCallId)}
                        >
                          Run tool <span className="opacity-70 text-xs ml-1">{isMac ? '⌘↵' : 'Ctrl+Enter'}</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </motion.li>
          );
        })}
      </ul>
    </motion.div>
  );
});
