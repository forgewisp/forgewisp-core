import { AuditLog } from './audit.js';
import { executeToolCalls } from './executor.js';
import { FunctionRegistry } from './registry.js';
import { AgentReasoning, AgentResult, ChatMessage, ForgewispConfig } from './types.js';
import type { LLMMessage } from './wire.js';

export interface ToolLoopDeps {
  callLLM: (
    messages: LLMMessage[],
    signal?: AbortSignal,
  ) => Promise<{
    message: LLMMessage;
    reasoning: string;
    reasoningTokens?: number;
  }>;
  registry: FunctionRegistry;
  audit: AuditLog;
  config: ForgewispConfig;
  maxToolRounds: number;
}

/**
 * Drives the chat → tool-call → chat loop until the model returns a final
 * response or the max-rounds cap is hit. Pure orchestration: HTTP and tool
 * execution are injected via `deps`.
 */
export async function runToolLoop(
  deps: ToolLoopDeps,
  userMessage: string,
  signal?: AbortSignal,
  history?: ChatMessage[],
): Promise<AgentResult> {
  const messages: LLMMessage[] = [];

  if (deps.config.systemPrompt) {
    messages.push({ role: 'system', content: deps.config.systemPrompt });
  }
  // Prior chat turns sit between the system prompt and the new user message.
  if (history) {
    for (const m of history) {
      messages.push({ role: m.role, content: m.content });
    }
  }
  messages.push({ role: 'user', content: userMessage });

  const allExecuted: AgentResult['toolCallsExecuted'] = [];
  const allAborted: AgentResult['toolCallsAborted'] = [];
  let accumulatedReasoning = '';
  let accumulatedReasoningTokens: number | undefined;

  const reasoningMode = deps.config.streaming?.reasoning?.mode ?? 'none';

  for (let round = 0; round < deps.maxToolRounds; round++) {
    const { message, reasoning, reasoningTokens } = await deps.callLLM(messages, signal);
    messages.push(message);

    if (reasoning) accumulatedReasoning += reasoning;
    if (reasoningTokens !== undefined) {
      accumulatedReasoningTokens = (accumulatedReasoningTokens ?? 0) + reasoningTokens;
    }

    // No tool calls → final response
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return {
        response: message.content ?? '',
        reasoning: buildReasoning(reasoningMode, accumulatedReasoning, accumulatedReasoningTokens),
        truncated: false,
        toolCallsExecuted: allExecuted,
        toolCallsAborted: allAborted,
      };
    }

    const { toolResults, executed, aborted } = await executeToolCalls(
      message.tool_calls,
      deps.registry,
      deps.audit,
      deps.config,
    );

    allExecuted.push(...executed);
    allAborted.push(...aborted);

    for (const result of toolResults) {
      let content: string;
      try {
        content = result.success
          ? JSON.stringify(result.result)
          : JSON.stringify({ error: result.error ?? result.abortReason });
      } catch (err) {
        // Handler returned a non-serializable value (e.g. circular). Don't let
        // it kill the run — fall back to a placeholder and audit the failure.
        const errMsg = err instanceof Error ? err.message : String(err);
        content = JSON.stringify({ error: '[non-serializable result]' });
        deps.audit.record('function_errored', result.functionName, {
          error: `result serialization failed: ${errMsg}`,
        });
      }
      messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content,
      });
    }
  }

  deps.audit.record('max_tool_rounds_reached', 'system', {
    error: `Exceeded ${deps.maxToolRounds} tool-call rounds without a final response.`,
  });

  return {
    response: '',
    reasoning: buildReasoning(reasoningMode, accumulatedReasoning, accumulatedReasoningTokens),
    truncated: true,
    toolCallsExecuted: allExecuted,
    toolCallsAborted: allAborted,
  };
}

function buildReasoning(
  mode: 'none' | 'extended' | 'tag-based' | 'native',
  text: string,
  tokens: number | undefined,
): AgentReasoning | undefined {
  if (mode === 'none' || !text) return undefined;
  return {
    mode,
    text,
    ...(tokens !== undefined ? { tokens } : {}),
  };
}
