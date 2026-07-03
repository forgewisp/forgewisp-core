import { AuditLog } from './audit.js';
import { StreamingConfig } from './types.js';
import type { LLMMessage, LLMToolCall, OpenAIChunk, StreamResult } from './wire.js';

// ─── Public entry point ───────────────────────────────────────────────────────

export async function streamCompletion(
  response: Response,
  streamingConfig: StreamingConfig,
  audit?: AuditLog,
  signal?: AbortSignal,
): Promise<StreamResult> {
  return parseOpenAIStream(response, streamingConfig, audit, signal);
}

// ─── Shared SSE line reader ───────────────────────────────────────────────────

async function* readSSELines(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('[Forgewisp] Response body is not readable.');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        yield line;
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) yield buffer;
  } finally {
    // Always release the reader lock, even if the consumer throws or aborts.
    reader.releaseLock();
  }
}

// ─── OpenAI SSE parser ────────────────────────────────────────────────────────
//
// OpenAI streams chat.completion.chunk objects. Each chunk has:
//   choices[0].delta.content          — text delta
//   choices[0].delta.tool_calls       — tool call fragments
//   choices[0].finish_reason          — "stop" | "tool_calls" | null
//
// For tag-based reasoning: text deltas are scanned in real time. When the
// opening tag is encountered, subsequent deltas are routed to onReasoningChunk
// until the closing tag is found. Partial tag markers that straddle a chunk
// boundary are buffered until the tag can be completed or ruled out.
//
// OpenAI o1/o3 extended reasoning: the API returns a separate
// `reasoning_tokens` count in `usage`, but does NOT stream reasoning content
// via SSE. For o1/o3 we surface the token count as a reasoning annotation
// rather than actual reasoning text. The reasoning field in StreamResult will
// be set to `[reasoning: ${count} tokens]` if reasoning_tokens > 0.

interface ToolCallAccumulator {
  id: string;
  nameParts: string[];
  argumentsParts: string[];
}

interface DecodedChunk {
  content?: string;
  toolCallDeltas?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  // Native reasoning delta streamed in a separate field (Ollama `reasoning`,
  // vLLM/DashScope `reasoning_content`). Routed to onReasoning in 'native' mode.
  reasoningContent?: string;
  reasoningTokens?: number;
}

function decodeChunk(chunk: OpenAIChunk): DecodedChunk {
  const reasoningTokens = chunk.usage?.completion_tokens_details?.reasoning_tokens || undefined;
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) {
    return reasoningTokens ? { reasoningTokens } : {};
  }
  const content =
    typeof delta.content === 'string' && delta.content.length > 0 ? delta.content : undefined;
  // Ollama streams `reasoning`; vLLM/DashScope stream `reasoning_content`. Prefer
  // `reasoning` and fall back to `reasoning_content` so a single mode covers both.
  const reasoningContent =
    typeof delta.reasoning === 'string' && delta.reasoning.length > 0
      ? delta.reasoning
      : typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
        ? delta.reasoning_content
        : undefined;
  const toolCallDeltas = delta.tool_calls?.map((tc) => ({
    index: tc.index,
    id: tc.id,
    name: tc.function?.name,
    arguments: tc.function?.arguments,
  }));
  const result: DecodedChunk = {};
  if (content) result.content = content;
  if (reasoningContent) result.reasoningContent = reasoningContent;
  if (toolCallDeltas) result.toolCallDeltas = toolCallDeltas;
  if (reasoningTokens) result.reasoningTokens = reasoningTokens;
  return result;
}

function assembleToolCalls(map: Map<number, ToolCallAccumulator>): LLMToolCall[] {
  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.nameParts.join(''), arguments: tc.argumentsParts.join('') },
    }));
}

async function parseOpenAIStream(
  response: Response,
  config: StreamingConfig,
  audit?: AuditLog,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const reasoning = config.reasoning ?? { mode: 'none' };

  // Accumulated state — arrays + join('') at flush, to avoid O(n²) string concat
  // on long streams. Callbacks still fire per-chunk (real-time UX).
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const tagState: TagRouteState = { inTag: false, pending: '' };
  const toolCallMap = new Map<number, ToolCallAccumulator>();
  let reasoningTokens = 0;

  // Tag-based: derive open/close tag strings once
  const openTag = reasoning.mode === 'tag-based' ? `<${reasoning.tag}>` : '';
  const closeTag = reasoning.mode === 'tag-based' ? `</${reasoning.tag}>` : '';

  const onText = (text: string): void => {
    textParts.push(text);
    config.onTextChunk?.(text);
  };
  const onReasoning = (text: string): void => {
    reasoningParts.push(text);
    config.onReasoningChunk?.(text);
  };

  for await (const line of readSSELines(response, signal)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;

    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(data) as OpenAIChunk;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      config.onMalformedChunk?.({ raw: data, error });
      audit?.record('stream_malformed', 'system', { error: `${error}: ${data}` });
      continue;
    }

    const decoded = decodeChunk(chunk);
    if (decoded.reasoningTokens) reasoningTokens = decoded.reasoningTokens;

    // ── Text content delta ───────────────────────────────────────────
    if (decoded.content) {
      if (reasoning.mode === 'tag-based') {
        routeTagBasedChunk(decoded.content, openTag, closeTag, tagState, onText, onReasoning);
      } else {
        onText(decoded.content);
      }
    }

    // ── Native reasoning delta (Ollama `reasoning` / vLLM `reasoning_content`)
    // Routed straight to the reasoning sink. Servers stream reasoning and text
    // as separate deltas, so this never overlaps with the content branch above.
    if (decoded.reasoningContent) {
      onReasoning(decoded.reasoningContent);
    }

    // ── Tool call fragments ──────────────────────────────────────────
    if (decoded.toolCallDeltas) {
      for (const tcDelta of decoded.toolCallDeltas) {
        const idx = tcDelta.index;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tcDelta.id ?? '', nameParts: [], argumentsParts: [] });
        }
        const tc = toolCallMap.get(idx);
        if (!tc) continue;
        if (tcDelta.name) tc.nameParts.push(tcDelta.name);
        if (tcDelta.arguments) tc.argumentsParts.push(tcDelta.arguments);
        if (tcDelta.id) tc.id = tcDelta.id;
      }
    }
  }

  // Flush any pending partial tag as plain content (no closing tag ever came)
  if (tagState.pending.length > 0) {
    if (tagState.inTag) {
      onReasoning(tagState.pending);
    } else {
      onText(tagState.pending);
    }
    tagState.pending = '';
  }

  const toolCalls = assembleToolCalls(toolCallMap);

  // ── Handle o1/o3 reasoning token annotation ──────────────────────────
  if (reasoning.mode === 'extended' && reasoningTokens > 0) {
    const annotation = `[reasoning: ${reasoningTokens} tokens]`;
    reasoningParts.length = 0;
    reasoningParts.push(annotation);
    config.onReasoningChunk?.(annotation);
  }

  const textAcc = textParts.join('');
  const reasoningAcc = reasoningParts.join('');

  const message: LLMMessage = {
    role: 'assistant',
    content: textAcc || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return {
    message,
    reasoning: reasoningAcc,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}

// ─── Tag-based routing helper ─────────────────────────────────────────────────
//
// Processes a text chunk in real time, splitting on opening/closing tags.
// Calls onText for content outside the tag, onReasoning for content inside.
// The open/close branches are symmetric: each step picks the active marker
// (openTag when outside, closeTag when inside) and the matching sink, scans
// for it, emits the prefix, and toggles state.inTag.

interface TagRouteState {
  inTag: boolean;
  pending: string;
}

function routeTagBasedChunk(
  chunk: string,
  openTag: string,
  closeTag: string,
  state: TagRouteState,
  onText: (s: string) => void,
  onReasoning: (s: string) => void,
): void {
  let remaining = chunk;
  state.pending = '';

  while (remaining.length > 0) {
    const marker = state.inTag ? closeTag : openTag;
    const emit = state.inTag ? onReasoning : onText;
    const idx = remaining.indexOf(marker);

    if (idx === -1) {
      const prefixLen = longestSuffixPrefix(remaining, marker);
      if (prefixLen > 0) {
        const emitLen = remaining.length - prefixLen;
        if (emitLen > 0) emit(remaining.slice(0, emitLen));
        state.pending = remaining.slice(emitLen);
      } else {
        emit(remaining);
      }
      break;
    }

    if (idx > 0) emit(remaining.slice(0, idx));
    remaining = remaining.slice(idx + marker.length);
    state.inTag = !state.inTag;
  }
}

/**
 * Returns the length of the longest suffix of `text` that is also a proper
 * prefix of `tag` (i.e. a partial tag marker that may continue in the next
 * chunk). Returns 0 if no such suffix exists. Capped at `tag.length - 1`
 * since a full match would have been found by indexOf.
 */
function longestSuffixPrefix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(text.slice(text.length - len))) {
      return len;
    }
  }
  return 0;
}
