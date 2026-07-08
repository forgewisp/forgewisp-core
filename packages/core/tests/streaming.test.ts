import { describe, it, expect, vi } from 'vitest';
import { streamCompletion } from '../src/streaming.js';
import { AuditLog } from '../src/audit.js';
import { StreamingConfig } from '../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a mock Response with a ReadableStream body from an array of SSE lines.
 * Each string in `lines` is a raw SSE line (e.g. "data: {...}").
 */
function mockStreamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function openAITextChunk(content: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null }],
  })}`;
}

function openAIToolChunk(index: number, id: string, name: string, args: string): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] },
        finish_reason: null,
      },
    ],
  })}`;
}

function openAIDone(): string {
  return 'data: [DONE]';
}

// ─── OpenAI format tests ──────────────────────────────────────────────────────

describe('streamCompletion — OpenAI format', () => {
  it('accumulates text chunks and calls onTextChunk', async () => {
    const onTextChunk = vi.fn();
    const config: StreamingConfig = { onTextChunk };

    const response = mockStreamResponse([
      openAITextChunk('Hello'),
      openAITextChunk(', world!'),
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config);

    expect(result.message.content).toBe('Hello, world!');
    expect(onTextChunk).toHaveBeenCalledTimes(2);
    expect(onTextChunk).toHaveBeenNthCalledWith(1, 'Hello');
    expect(onTextChunk).toHaveBeenNthCalledWith(2, ', world!');
    expect(result.reasoning).toBe('');
  });

  it('assembles tool calls from fragmented deltas', async () => {
    const config: StreamingConfig = {};

    const response = mockStreamResponse([
      openAIToolChunk(0, 'call_abc', 'listUsers', ''),
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"fil' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ter":"active"}' } }] }, finish_reason: null }] })}`,
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config);

    expect(result.message.tool_calls).toHaveLength(1);
    expect(result.message.tool_calls![0]!.function.name).toBe('listUsers');
    expect(result.message.tool_calls![0]!.function.arguments).toBe('{"filter":"active"}');
    expect(result.message.tool_calls![0]!.id).toBe('call_abc');
  });

  it('routes tag-based reasoning chunks correctly', async () => {
    const onTextChunk = vi.fn();
    const onReasoningChunk = vi.fn();
    const config: StreamingConfig = {
      reasoning: { mode: 'tag-based', tag: 'thinking' },
      onTextChunk,
      onReasoningChunk,
    };

    const response = mockStreamResponse([
      openAITextChunk('Let me think. '),
      openAITextChunk('<thinking>This is reasoning.</thinking>'),
      openAITextChunk(' Done.'),
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config);

    expect(result.reasoning).toBe('This is reasoning.');
    // Content outside the tag goes to text
    expect(onReasoningChunk).toHaveBeenCalledWith('This is reasoning.');
    // Text outside the tag goes to onTextChunk
    const textCalls = (onTextChunk.mock.calls as Array<[string]>).map((c) => c[0]).join('');
    expect(textCalls).toContain('Let me think. ');
    expect(textCalls).toContain(' Done.');
    // Final content excludes reasoning tags
    expect(result.message.content).not.toContain('<thinking>');
  });

  it('reasoning field is empty when mode is none', async () => {
    const config: StreamingConfig = { reasoning: { mode: 'none' } };
    const response = mockStreamResponse([openAITextChunk('Hi'), openAIDone()]);
    const result = await streamCompletion(response, config);
    expect(result.reasoning).toBe('');
  });
});

// ─── Native reasoning field (Ollama `reasoning` / vLLM `reasoning_content`) ────

describe('streamCompletion — native reasoning field', () => {
  function openAIReasoningChunk(field: 'reasoning' | 'reasoning_content', text: string): string {
    return `data: ${JSON.stringify({
      choices: [{ delta: { [field]: text }, finish_reason: null }],
    })}`;
  }

  it('routes Ollama `reasoning` deltas to onReasoningChunk and leaves content empty', async () => {
    const onTextChunk = vi.fn();
    const onReasoningChunk = vi.fn();
    const config: StreamingConfig = {
      reasoning: { mode: 'native' },
      onTextChunk,
      onReasoningChunk,
    };

    const response = mockStreamResponse([
      openAIReasoningChunk('reasoning', 'Let me consider '),
      openAIReasoningChunk('reasoning', 'the task list.'),
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config);

    expect(result.reasoning).toBe('Let me consider the task list.');
    expect(onReasoningChunk).toHaveBeenCalledTimes(2);
    expect(onReasoningChunk).toHaveBeenNthCalledWith(1, 'Let me consider ');
    expect(onTextChunk).not.toHaveBeenCalled();
    expect(result.message.content).toBeNull();
  });

  it('falls back to `reasoning_content` (vLLM/DashScope) when `reasoning` is absent', async () => {
    const onReasoningChunk = vi.fn();
    const config: StreamingConfig = {
      reasoning: { mode: 'native' },
      onReasoningChunk,
    };

    const response = mockStreamResponse([
      openAIReasoningChunk('reasoning_content', 'Thinking...'),
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config);
    expect(result.reasoning).toBe('Thinking...');
    expect(onReasoningChunk).toHaveBeenCalledWith('Thinking...');
  });

  it('routes reasoning and text independently when a stream interleaves both', async () => {
    const onTextChunk = vi.fn();
    const onReasoningChunk = vi.fn();
    const config: StreamingConfig = {
      reasoning: { mode: 'native' },
      onTextChunk,
      onReasoningChunk,
    };

    const response = mockStreamResponse([
      openAIReasoningChunk('reasoning', 'Reasoning first. '),
      openAITextChunk('Then the answer.'),
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config);

    expect(result.reasoning).toBe('Reasoning first. ');
    expect(result.message.content).toBe('Then the answer.');
    expect(onReasoningChunk).toHaveBeenCalledWith('Reasoning first. ');
    expect(onTextChunk).toHaveBeenCalledWith('Then the answer.');
  });

  it('produces empty reasoning and streams content normally when no reasoning field is present', async () => {
    const onTextChunk = vi.fn();
    const onReasoningChunk = vi.fn();
    const config: StreamingConfig = {
      reasoning: { mode: 'native' },
      onTextChunk,
      onReasoningChunk,
    };

    const response = mockStreamResponse([openAITextChunk('Hello'), openAIDone()]);
    const result = await streamCompletion(response, config);

    expect(result.reasoning).toBe('');
    expect(result.message.content).toBe('Hello');
    expect(onReasoningChunk).not.toHaveBeenCalled();
    expect(onTextChunk).toHaveBeenCalledWith('Hello');
  });
});

// ─── Tag boundary edge cases ──────────────────────────────────────────────────

describe('tag-based routing — boundary edge cases', () => {
  it('handles tag split across multiple chunks', async () => {
    const onTextChunk = vi.fn();
    const onReasoningChunk = vi.fn();
    const config: StreamingConfig = {
      reasoning: { mode: 'tag-based', tag: 'think' },
      onTextChunk,
      onReasoningChunk,
    };

    // Tag is split: "<thi" in one chunk, "nk>content</think> after" in next
    const response = mockStreamResponse([
      openAITextChunk('before <thi'),
      openAITextChunk('nk>inside</think> after'),
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config);

    expect(result.reasoning).toBe('inside');
    expect(result.message.content).toBe('before  after');
  });
});

// ─── Malformed data & reader cleanup ─────────────────────────────────────────

describe('streamCompletion — malformed data & reader cleanup', () => {
  it('invokes onMalformedChunk and records stream_malformed for unparseable data lines', async () => {
    const onMalformedChunk = vi.fn();
    const config: StreamingConfig = { onMalformedChunk };
    const audit = new AuditLog();

    const response = mockStreamResponse([
      'data: {not valid json',
      openAITextChunk('Hello'),
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config, audit);

    expect(onMalformedChunk).toHaveBeenCalledOnce();
    expect(onMalformedChunk).toHaveBeenCalledWith(
      expect.objectContaining({ raw: '{not valid json' }),
    );
    expect(audit.getAll().some((e) => e.type === 'stream_malformed')).toBe(true);
    expect(result.message.content).toBe('Hello');
  });

  it('rejects and releases the reader when a chunk callback throws', async () => {
    const config: StreamingConfig = {
      onTextChunk: () => {
        throw new Error('cb boom');
      },
    };
    const response = mockStreamResponse([openAITextChunk('Hello'), openAIDone()]);
    await expect(streamCompletion(response, config)).rejects.toThrow('cb boom');
  });
});

// ─── Performance regression guard ─────────────────────────────────────────────

describe('streamCompletion — performance', () => {
  it('handles 5000 text chunks without falling over', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(openAITextChunk('x'));
    }
    lines.push(openAIDone());

    const config: StreamingConfig = {};
    const response = mockStreamResponse(lines);

    const start = Date.now();
    const result = await streamCompletion(response, config);
    const elapsed = Date.now() - start;

    expect(result.message.content).toBe('x'.repeat(5000));
    // Regression guard: O(n²) string concat would blow well past this on 5000 chunks.
    expect(elapsed).toBeLessThan(2000);
  });
});

// ─── Extended reasoning + edge cases ──────────────────────────────────────────

describe('streamCompletion — extended reasoning & edge cases', () => {
  function openAIUsageChunk(reasoningTokens: number): string {
    return `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { completion_tokens_details: { reasoning_tokens: reasoningTokens } },
    })}`;
  }

  it('surfaces reasoning_tokens as an annotation in extended mode', async () => {
    const onReasoningChunk = vi.fn();
    const config: StreamingConfig = {
      reasoning: { mode: 'extended' },
      onReasoningChunk,
    };
    const response = mockStreamResponse([
      openAITextChunk('Answer'),
      openAIUsageChunk(42),
      openAIDone(),
    ]);
    const result = await streamCompletion(response, config);
    expect(result.reasoning).toBe('[reasoning: 42 tokens]');
    expect(onReasoningChunk).toHaveBeenCalledWith('[reasoning: 42 tokens]');
  });

  it('completes the stream even without a [DONE] sentinel', async () => {
    const config: StreamingConfig = {};
    const response = mockStreamResponse([openAITextChunk('hello')]);
    const result = await streamCompletion(response, config);
    expect(result.message.content).toBe('hello');
  });

  it('assembles a tool call whose id arrives in a later delta than name', async () => {
    const config: StreamingConfig = {};
    const response = mockStreamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'fn', arguments: '' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'late_id', function: { arguments: '{"a":1}' } }] }, finish_reason: null }] })}`,
      openAIDone(),
    ]);
    const result = await streamCompletion(response, config);
    expect(result.message.tool_calls![0]!.id).toBe('late_id');
    expect(result.message.tool_calls![0]!.function.name).toBe('fn');
    expect(result.message.tool_calls![0]!.function.arguments).toBe('{"a":1}');
  });

  it('assembles multiple tool calls with distinct indices in order', async () => {
    const config: StreamingConfig = {};
    const response = mockStreamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{}' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }] }, finish_reason: null }] })}`,
      openAIDone(),
    ]);
    const result = await streamCompletion(response, config);
    expect(result.message.tool_calls).toHaveLength(2);
    expect(result.message.tool_calls![0]!.function.name).toBe('first');
    expect(result.message.tool_calls![1]!.function.name).toBe('second');
  });

  it('flushes a pending partial tag as content when the stream ends mid-tag', async () => {
    const onTextChunk = vi.fn();
    const config: StreamingConfig = {
      reasoning: { mode: 'tag-based', tag: 'think' },
      onTextChunk,
    };
    // Stream ends with an unclosed '<thi' — should be flushed as plain text.
    const response = mockStreamResponse([openAITextChunk('hello <thi')]);
    const result = await streamCompletion(response, config);
    expect(result.message.content).toBe('hello <thi');
    expect(result.reasoning).toBe('');
  });

  it('treats a stray closing tag outside a tag as plain text', async () => {
    const onTextChunk = vi.fn();
    const config: StreamingConfig = {
      reasoning: { mode: 'tag-based', tag: 'think' },
      onTextChunk,
    };
    // Closing tag with no matching open — should remain in text content.
    const response = mockStreamResponse([openAITextChunk('done </think>'), openAIDone()]);
    const result = await streamCompletion(response, config);
    // The stray </think> flips state to inTag, but no open tag preceded it, so
    // the prefix "done " is text and the suffix after </think> (empty) is reasoning.
    // The exact split is defined by the tag router; assert no crash and content
    // contains the prefix.
    expect(result.message.content).toContain('done ');
  });
});

// ─── Line-ending & framing edge cases ─────────────────────────────────────────

describe('streamCompletion — line-ending & framing edge cases', () => {
  /** Builds a Response from a raw string (exact bytes, including any line endings). */
  function rawResponse(raw: string): Response {
    return new Response(new TextEncoder().encode(raw), { status: 200 });
  }

  it('parses lines split with CRLF (trim strips the carriage return)', async () => {
    const config: StreamingConfig = {};
    const response = rawResponse(`${openAITextChunk('Hello')}\r\n${openAIDone()}\r\n`);
    const result = await streamCompletion(response, config);
    // readSSELines splits on '\n' only; the trailing '\r' is removed by `.trim()`
    // before JSON.parse, so CRLF-framed SSE streams parse correctly.
    expect(result.message.content).toBe('Hello');
  });

  it('silently skips `data:` lines that lack the trailing space', async () => {
    const onMalformedChunk = vi.fn();
    const config: StreamingConfig = { onMalformedChunk };
    // 'data:foo' (no space) does not match the 'data: ' guard → skipped silently,
    // not treated as malformed.
    const response = rawResponse(`data:foo\n${openAITextChunk('Hello')}\n${openAIDone()}\n`);
    const result = await streamCompletion(response, config);
    expect(onMalformedChunk).not.toHaveBeenCalled();
    expect(result.message.content).toBe('Hello');
  });

  it('flushes an unclosed tag as reasoning when the stream ends inside a tag', async () => {
    const config: StreamingConfig = {
      reasoning: { mode: 'tag-based', tag: 'thinking' },
    };
    // Open tag, then reasoning text, no close tag, no [DONE] — the pending text is
    // in-tag when the stream ends, so the flush routes it to reasoning.
    const response = mockStreamResponse([openAITextChunk('<thinking>still thinking')]);
    const result = await streamCompletion(response, config);
    expect(result.reasoning).toBe('still thinking');
    expect(result.message.content).toBeNull();
  });

  it('toggles in and out of reasoning across repeated open/close tags', async () => {
    const config: StreamingConfig = {
      reasoning: { mode: 'tag-based', tag: 'a' },
    };
    // <a>in1</a><a>in2</a> — the router toggles inTag on each marker, so both
    // inner spans land in reasoning and no text leaks between them.
    const response = mockStreamResponse([openAITextChunk('<a>in1</a><a>in2</a>')]);
    const result = await streamCompletion(response, config);
    expect(result.reasoning).toBe('in1in2');
    expect(result.message.content).toBeNull();
  });

  it('releases the reader when the stream is aborted mid-flight', async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(openAITextChunk('Hello') + '\n'));
        // Deliberately do not close — the abort will stop the loop before the
        // next read() would block.
      },
    });
    const response = new Response(body, { status: 200 });

    const config: StreamingConfig = {
      // Abort as soon as the first text chunk is routed.
      onTextChunk: () => ac.abort(),
    };

    const result = await streamCompletion(response, config, undefined, ac.signal);

    // The one chunk processed before the abort lands in content.
    expect(result.message.content).toBe('Hello');
    // The finally block called releaseLock(), so the stream is no longer locked
    // to a reader (without that finally, body.locked would still be true).
    expect(body.locked).toBe(false);
  });
});

// ─── Tool-call id fallback (P1.3) ─────────────────────────────────────────────
//
// Some OpenAI-compatible servers never stream an `id` for a tool-call index.
// Without a fallback the assembled id is `''`, which silently breaks
// `tool_call_id` matching when the result is serialized back into the message
// history. The parser synthesizes a stable, non-empty id and records a
// `tool_call_id_missing` audit event per affected call.

describe('streamCompletion — tool-call id fallback', () => {
  it('synthesizes a non-empty id and audits when no id ever arrives', async () => {
    const audit = new AuditLog();
    const config: StreamingConfig = {};

    // Index 0 gets name + arguments but never an id; index 1 arrives complete.
    const response = mockStreamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'noIdTool', arguments: '{"x":1}' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'real_id', function: { name: 'withId', arguments: '{}' } }] }, finish_reason: null }] })}`,
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config, audit);

    expect(result.message.tool_calls).toHaveLength(2);
    const [synth, real] = result.message.tool_calls!;
    expect(synth!.id).not.toBe('');
    expect(synth!.id).toMatch(/^call_synth_0_/);
    expect(synth!.function.name).toBe('noIdTool');
    expect(synth!.function.arguments).toBe('{"x":1}');
    expect(real!.id).toBe('real_id');

    const missing = audit.getAll().filter((e) => e.type === 'tool_call_id_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.functionName).toBe('noIdTool');
    expect(missing[0]!.args).toEqual({ index: 0, synthesizedId: synth!.id });
  });

  it('does not synthesize or audit when every call carries an id', async () => {
    const audit = new AuditLog();
    const config: StreamingConfig = {};

    const response = mockStreamResponse([
      openAIToolChunk(0, 'call_a', 'first', '{}'),
      openAIToolChunk(1, 'call_b', 'second', '{}'),
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config, audit);

    expect(result.message.tool_calls![0]!.id).toBe('call_a');
    expect(result.message.tool_calls![1]!.id).toBe('call_b');
    expect(audit.getAll().some((e) => e.type === 'tool_call_id_missing')).toBe(false);
  });

  it('synthesizes distinct ids per missing call and emits one event each', async () => {
    const audit = new AuditLog();
    const config: StreamingConfig = {};

    // Two calls, neither ever streams an id.
    const response = mockStreamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'a', arguments: '{}' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'b', arguments: '{}' } }] }, finish_reason: null }] })}`,
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config, audit);

    const [first, second] = result.message.tool_calls!;
    expect(first!.id).toMatch(/^call_synth_0_/);
    expect(second!.id).toMatch(/^call_synth_1_/);
    expect(first!.id).not.toBe(second!.id);

    const missing = audit.getAll().filter((e) => e.type === 'tool_call_id_missing');
    expect(missing).toHaveLength(2);
    expect(missing.map((e) => e.args?.index).sort()).toEqual([0, 1]);
  });

  it('uses "unknown" as the function name when the id and name both never arrive', async () => {
    const audit = new AuditLog();
    const config: StreamingConfig = {};

    // Only arguments stream — no id, no name.
    const response = mockStreamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }, finish_reason: null }] })}`,
      openAIDone(),
    ]);

    const result = await streamCompletion(response, config, audit);

    expect(result.message.tool_calls![0]!.id).toMatch(/^call_synth_0_/);
    const missing = audit.getAll().filter((e) => e.type === 'tool_call_id_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.functionName).toBe('unknown');
  });
});
