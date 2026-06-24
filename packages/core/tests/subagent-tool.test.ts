// Node env (no DOM surface): the factory drives a real subagent via a stubbed fetch,
// matching the pattern in agent.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createSubagentTool } from '../src/subagent-tool.js';
import type { ForgewispConfig, FunctionDefinition } from '../src/types.js';
import type { LLMMessage } from '../src/wire.js';
import type { SpawnSubagentResult } from '../src/subagent-tool.js';

const baseConfig: ForgewispConfig = {
  llmEndpoint: 'https://example.com/v1/chat/completions',
  model: 'gpt-4o',
  // Disable the per-request timeout so the abort-signal test isn't raced by it.
  requestTimeoutMs: 0,
};

function makeTool(name: string): FunctionDefinition<never> {
  return {
    name,
    description: `${name} tool`,
    riskTier: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: () => name,
  };
}

function nonStreamResponse(message: LLMMessage): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const finalMessage = (text: string): LLMMessage => ({ role: 'assistant', content: text });

const toolCallMessage = (name: string, args: Record<string, unknown>): LLMMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

/** Read the `tools` array names from the first subagent fetch request body. */
function grantedToolNames(calls: Array<[string, RequestInit]>): string[] {
  const body = JSON.parse(calls[0]![1].body as string) as {
    tools?: Array<{ function: { name: string } }>;
  };
  return (body.tools ?? []).map((t) => t.function.name);
}

/** Read the subagent's messages array from the first fetch request body. */
function requestMessages(
  calls: Array<[string, RequestInit]>,
): Array<{ role: string; content: string }> {
  const body = JSON.parse(calls[0]![1].body as string) as {
    messages: Array<{ role: string; content: string }>;
  };
  return body.messages;
}

describe('createSubagentTool', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('produces the expected FunctionDefinition shape and lists the pool tool names in the description', () => {
    const tool = createSubagentTool({
      config: baseConfig,
      tools: [makeTool('getCurrentTime'), makeTool('hashText')],
    });
    expect(tool.name).toBe('spawnSubagent');
    expect(tool.riskTier).toBe('read');
    expect(typeof tool.handler).toBe('function');

    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.required).toEqual(['task']);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.parameters.properties.tools?.maxItems).toBe(20);

    // The description names the exact pool tools so the parent LLM stops guessing.
    expect(tool.description).toContain('getCurrentTime');
    expect(tool.description).toContain('hashText');
    expect(tool.description).toContain('Never include "spawnSubagent"');
  });

  it('grants the whole pool when args.tools is omitted', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('final answer'))));
    vi.stubGlobal('fetch', fetchMock);

    const tool = createSubagentTool({
      config: baseConfig,
      tools: [makeTool('getCurrentTime'), makeTool('hashText')],
    });
    const result = (await tool.handler({ task: 'do thing' })) as SpawnSubagentResult;

    expect(result).toEqual({
      response: 'final answer',
      truncated: false,
      toolCallsExecuted: 0,
      toolCallsAborted: 0,
    });
    expect(result).not.toHaveProperty('reasoning');
    expect(grantedToolNames(fetchMock.mock.calls as Array<[string, RequestInit]>)).toEqual([
      'getCurrentTime',
      'hashText',
    ]);
  });

  it('grants only the named subset when args.tools matches', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('ok'))));
    vi.stubGlobal('fetch', fetchMock);

    const tool = createSubagentTool({
      config: baseConfig,
      tools: [makeTool('getCurrentTime'), makeTool('hashText'), makeTool('encodeBase64')],
    });
    await tool.handler({ task: 'x', tools: ['hashText'] });

    expect(grantedToolNames(fetchMock.mock.calls as Array<[string, RequestInit]>)).toEqual([
      'hashText',
    ]);
  });

  it('falls back to the whole pool when args.tools names nothing matching (root-cause fix)', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('ok'))));
    vi.stubGlobal('fetch', fetchMock);

    const tool = createSubagentTool({
      config: baseConfig,
      tools: [makeTool('getCurrentTime'), makeTool('hashText')],
    });
    // The LLM guessed wrong names ("time", "hash") — none match. The factory must NOT
    // register zero tools; it falls back to the whole pool.
    await tool.handler({ task: 'x', tools: ['time', 'hash'] });

    expect(grantedToolNames(fetchMock.mock.calls as Array<[string, RequestInit]>)).toEqual([
      'getCurrentTime',
      'hashText',
    ]);
  });

  it('filters "spawnSubagent" out of the pool (recursion guard)', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('ok'))));
    vi.stubGlobal('fetch', fetchMock);

    const tool = createSubagentTool({
      config: baseConfig,
      tools: [makeTool('spawnSubagent'), makeTool('getCurrentTime')],
    });
    await tool.handler({ task: 'x' });

    expect(grantedToolNames(fetchMock.mock.calls as Array<[string, RequestInit]>)).toEqual([
      'getCurrentTime',
    ]);
  });

  it('threads the parent run AbortSignal into the subagent run (abort propagates)', async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createSubagentTool({ config: baseConfig, tools: [makeTool('getCurrentTime')] });
    const ac = new AbortController();
    const pending = tool.handler(
      { task: 'x' },
      { signal: ac.signal },
    ) as Promise<SpawnSubagentResult>;
    ac.abort();
    await expect(pending).rejects.toThrow();
  });

  it('does NOT inherit the parent system prompt and strips the parent streaming UI callbacks', async () => {
    const onTextChunk = vi.fn();
    const onReasoningChunk = vi.fn();
    const parentConfig: ForgewispConfig = {
      ...baseConfig,
      systemPrompt: 'You are a pure orchestration agent.',
      streaming: { reasoning: { mode: 'native' }, onTextChunk, onReasoningChunk },
    };

    // The subagent keeps the reasoning mode (so it streams) but its onTextChunk/
    // onReasoningChunk are stripped — provide an SSE stream so the streaming path runs.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'subanswer' } }] })}\n`,
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const tool = createSubagentTool({
      config: parentConfig,
      tools: [makeTool('getCurrentTime')],
      systemPrompt: 'You are a focused subagent.',
    });
    const result = (await tool.handler({ task: 'x' })) as SpawnSubagentResult;

    // Subagent used the factory system prompt, not the parent's orchestrator prompt.
    const messages = requestMessages(fetchMock.mock.calls as Array<[string, RequestInit]>);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('You are a focused subagent.');

    // The subagent streamed (returned the streamed content) but never touched the
    // parent's UI callbacks — its intermediate output did not pollute the parent.
    expect(result.response).toBe('subanswer');
    expect(onTextChunk).not.toHaveBeenCalled();
    expect(onReasoningChunk).not.toHaveBeenCalled();
  });

  it('counts tool calls and reflects truncation in the trimmed result', async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1)
        return Promise.resolve(nonStreamResponse(toolCallMessage('getCurrentTime', {})));
      return Promise.resolve(nonStreamResponse(finalMessage('done')));
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createSubagentTool({ config: baseConfig, tools: [makeTool('getCurrentTime')] });
    const result = (await tool.handler({ task: 'x' })) as SpawnSubagentResult;

    expect(result.response).toBe('done');
    expect(result.truncated).toBe(false);
    expect(result.toolCallsExecuted).toBe(1);
    expect(result.toolCallsAborted).toBe(0);
  });
});
