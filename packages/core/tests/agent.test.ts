import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgent } from '../src/index.js';
import { AuditEvent, ForgewispConfig } from '../src/types.js';
import type { LLMMessage } from '../src/wire.js';

const baseAgentConfig: ForgewispConfig = {
  llmEndpoint: 'https://example.com/v1/chat/completions',
  model: 'gpt-4o',
  requestTimeoutMs: 0,
};

function nonStreamResponse(message: LLMMessage): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toolCallMessage(name: string, args: Record<string, unknown>): LLMMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

function finalMessage(text: string): LLMMessage {
  return { role: 'assistant', content: text };
}

describe('ForgewispAgent.run', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('runs a single tool round and returns the final response', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.resolve(nonStreamResponse(toolCallMessage('ping', {})));
        return Promise.resolve(nonStreamResponse(finalMessage('done')));
      }),
    );

    const agent = createAgent(baseAgentConfig);
    agent.registerFunction({
      name: 'ping',
      description: 'Ping',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 'pong',
    });

    const result = await agent.run('hi');
    expect(result.response).toBe('done');
    expect(result.truncated).toBe(false);
    expect(result.toolCallsExecuted).toHaveLength(1);
    expect(result.toolCallsExecuted[0]!.result).toBe('pong');
  });

  it('dispatches via streaming when streaming config is present', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n`),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const agent = createAgent({ ...baseAgentConfig, streaming: {} });
    const result = await agent.run('hi');
    expect(result.response).toBe('Hi');
    expect(result.truncated).toBe(false);
  });

  it('returns truncated:true and records max_tool_rounds_reached when the cap is hit', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() => Promise.resolve(nonStreamResponse(toolCallMessage('ping', {})))),
    );

    const onAuditEvent = vi.fn();
    const agent = createAgent({ ...baseAgentConfig, onAuditEvent });
    agent.registerFunction({
      name: 'ping',
      description: 'Ping',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 'pong',
    });

    const result = await agent.run('hi');
    expect(result.truncated).toBe(true);
    expect(result.response).toBe('');
    expect(result.toolCallsExecuted).toHaveLength(10);
    expect(agent.getAuditLog().some((e) => e.type === 'max_tool_rounds_reached')).toBe(true);
  });

  it('falls back to a placeholder and audits when a handler returns a circular value', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.resolve(nonStreamResponse(toolCallMessage('circular', {})));
        return Promise.resolve(nonStreamResponse(finalMessage('ok')));
      }),
    );

    const agent = createAgent(baseAgentConfig);
    agent.registerFunction({
      name: 'circular',
      description: 'Circular',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => {
        const o: Record<string, unknown> = {};
        o.self = o;
        return o;
      },
    });

    const result = await agent.run('hi');
    expect(result.response).toBe('ok');
    expect(
      agent
        .getAuditLog()
        .some((e) => e.type === 'function_errored' && e.error?.includes('serialization')),
    ).toBe(true);
  });

  it('rejects when the external signal is already aborted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: { signal?: AbortSignal }) => {
        if (init.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
        return Promise.resolve(nonStreamResponse(finalMessage('done')));
      }),
    );

    const agent = createAgent(baseAgentConfig);
    const ac = new AbortController();
    ac.abort();
    await expect(agent.run('hi', { signal: ac.signal })).rejects.toThrow();
  });

  it('rejects when the request times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: { signal?: AbortSignal }) => {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }),
    );

    const agent = createAgent({ ...baseAgentConfig, requestTimeoutMs: 50 });
    await expect(agent.run('hi')).rejects.toThrow();
  });

  it('sends the expected body and headers to the LLM endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('done'))));
    vi.stubGlobal('fetch', fetchMock);

    const agent = createAgent({
      ...baseAgentConfig,
      apiKey: 'sk-test',
      systemPrompt: 'You are helpful.',
    });
    agent.registerFunction({
      name: 'ping',
      description: 'Ping',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 'pong',
    });

    await agent.run('hello');

    expect(fetchMock).toHaveBeenCalledOnce();
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const [url, init] = calls[0]!;
    expect(url).toBe('https://example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o');
    expect(body['stream']).toBe(false);
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('You are helpful.');
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toBe('hello');
  });

  it('prepends chat history between the system prompt and the new user message', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('ok'))));
    vi.stubGlobal('fetch', fetchMock);

    const agent = createAgent({
      ...baseAgentConfig,
      systemPrompt: 'You are helpful.',
    });

    await agent.run('remember this', {
      history: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'noted' },
      ],
    });

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as Record<string, unknown>;
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(4);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'earlier' });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'noted' });
    expect(messages[3]).toEqual({ role: 'user', content: 'remember this' });
  });

  it('prepends history without a system prompt when none is configured', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('ok'))));
    vi.stubGlobal('fetch', fetchMock);

    const agent = createAgent(baseAgentConfig);

    await agent.run('now', {
      history: [{ role: 'user', content: 'before' }],
    });

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as Record<string, unknown>;
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: 'user', content: 'before' },
      { role: 'user', content: 'now' },
    ]);
  });

  it('includes tools and tool_choice in the body when functions are registered', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('done'))));
    vi.stubGlobal('fetch', fetchMock);

    const agent = createAgent(baseAgentConfig);
    agent.registerFunction({
      name: 'listTasks',
      description: 'List tasks',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => [],
    });

    await agent.run('list');

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as Record<string, unknown>;
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'listTasks',
          description: 'List tasks',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ]);
    expect(body['tool_choice']).toBe('auto');
  });

  it('omits tools and tool_choice when no functions are registered', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('done'))));
    vi.stubGlobal('fetch', fetchMock);

    const agent = createAgent(baseAgentConfig);
    await agent.run('hi');

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as Record<string, unknown>;
    expect(body['tools']).toBeUndefined();
    expect(body['tool_choice']).toBeUndefined();
  });

  it('throws at registerFunction time for write/destructive tools without onConfirmRequired', () => {
    const agent = createAgent(baseAgentConfig);
    // read tier is fine
    expect(() =>
      agent.registerFunction({
        name: 'r',
        description: 'R',
        riskTier: 'read',
        parameters: { type: 'object', properties: {}, required: [] },
        handler: () => 1,
      }),
    ).not.toThrow();
    // write tier without onConfirmRequired throws
    expect(() =>
      agent.registerFunction({
        name: 'w',
        description: 'W',
        riskTier: 'write',
        parameters: { type: 'object', properties: {}, required: [] },
        handler: () => 1,
      }),
    ).toThrow('onConfirmRequired');
    // destructive tier without onConfirmRequired throws
    expect(() =>
      agent.registerFunction({
        name: 'd',
        description: 'D',
        riskTier: 'destructive',
        parameters: { type: 'object', properties: {}, required: [] },
        handler: () => 1,
      }),
    ).toThrow('onConfirmRequired');
  });

  it('respects maxToolRounds from config', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() => Promise.resolve(nonStreamResponse(toolCallMessage('ping', {})))),
    );
    const agent = createAgent({ ...baseAgentConfig, maxToolRounds: 2 });
    agent.registerFunction({
      name: 'ping',
      description: 'Ping',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 'pong',
    });
    const result = await agent.run('hi');
    expect(result.truncated).toBe(true);
    expect(result.toolCallsExecuted).toHaveLength(2);
  });

  it('returns structured reasoning with mode and text for tag-based streaming', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '<thinking>because</thinking>yes' } }] })}\n`,
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const agent = createAgent({
      ...baseAgentConfig,
      streaming: { reasoning: { mode: 'tag-based', tag: 'thinking' } },
    });
    const result = await agent.run('why?');
    expect(result.reasoning).toBeDefined();
    expect(result.reasoning!.mode).toBe('tag-based');
    expect(result.reasoning!.text).toBe('because');
    expect(result.response).toBe('yes');
  });

  it('returns structured reasoning with tokens for extended mode', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { completion_tokens_details: { reasoning_tokens: 99 } },
            })}\n`,
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const agent = createAgent({
      ...baseAgentConfig,
      streaming: { reasoning: { mode: 'extended' } },
    });
    const result = await agent.run('why?');
    expect(result.reasoning).toBeDefined();
    expect(result.reasoning!.mode).toBe('extended');
    expect(result.reasoning!.tokens).toBe(99);
  });

  it('redacts audit events via audit.redact before storage and callback', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() => Promise.resolve(nonStreamResponse(toolCallMessage('ping', {})))),
    );
    const seen: AuditEvent[] = [];
    const agent = createAgent({
      ...baseAgentConfig,
      audit: {
        onEvent: (e) => seen.push(e),
        redact: (e) =>
          e.args ? { ...e, args: { redacted: true } satisfies Record<string, unknown> } : e,
      },
    });
    agent.registerFunction({
      name: 'ping',
      description: 'Ping',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 'pong',
    });

    await agent.run('hi');

    const requested = seen.find((e) => e.type === 'function_requested');
    expect(requested?.args).toEqual({ redacted: true });
    // Internal log is also redacted.
    const stored = agent.getAuditLog().find((e) => e.type === 'function_requested');
    expect(stored?.args).toEqual({ redacted: true });
  });

  it('confirms and executes a write-tier tool mid-run when onConfirmRequired returns true', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1)
          return Promise.resolve(nonStreamResponse(toolCallMessage('save', { value: 'x' })));
        return Promise.resolve(nonStreamResponse(finalMessage('done')));
      }),
    );

    const onConfirmRequired = vi.fn().mockResolvedValue(true);
    const handler = vi.fn(() => 'saved');
    const agent = createAgent({ ...baseAgentConfig, onConfirmRequired });
    agent.registerFunction({
      name: 'save',
      description: 'Save',
      riskTier: 'write',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      handler,
    });

    const result = await agent.run('save x');

    expect(onConfirmRequired).toHaveBeenCalledOnce();
    // The handler receives schema-validated args, not raw LLM output.
    expect(handler).toHaveBeenCalledWith({ value: 'x' }, { signal: undefined });
    expect(result.toolCallsExecuted).toHaveLength(1);
    expect(result.toolCallsExecuted[0]!.functionName).toBe('save');
    expect(result.toolCallsExecuted[0]!.result).toBe('saved');
    expect(result.truncated).toBe(false);
    expect(result.response).toBe('done');
  });

  it('surfaces a rejected destructive tool in toolCallsAborted and never calls the handler', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.resolve(nonStreamResponse(toolCallMessage('delete', {})));
        return Promise.resolve(nonStreamResponse(finalMessage('ok')));
      }),
    );

    const handler = vi.fn();
    const onConfirmRequired = vi.fn().mockResolvedValue(false);
    const agent = createAgent({ ...baseAgentConfig, onConfirmRequired });
    agent.registerFunction({
      name: 'delete',
      description: 'Delete',
      riskTier: 'destructive',
      parameters: { type: 'object', properties: {}, required: [] },
      handler,
    });

    const result = await agent.run('delete it');

    expect(onConfirmRequired).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(result.toolCallsAborted).toHaveLength(1);
    expect(result.toolCallsAborted[0]!.reason).toBe('confirmation_rejected');
    expect(result.truncated).toBe(false);
    expect(result.response).toBe('ok');
  });

  it('omits the Authorization header when no apiKey is configured', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('done'))));
    vi.stubGlobal('fetch', fetchMock);

    const agent = createAgent(baseAgentConfig); // no apiKey
    await agent.run('hi');

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const headers = calls[0]![1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('assembles tool calls received over a streaming response and runs the tool', async () => {
    const encoder = new TextEncoder();
    const sse = (lines: string[]): Response => {
      const stream = new ReadableStream({
        start(controller) {
          for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          // Fragmented tool-call deltas: name+id in the first chunk, args in the
          // second (matching how OpenAI splits a tool call across deltas).
          return Promise.resolve(
            sse([
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ping', arguments: '' } }] }, finish_reason: null }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }, finish_reason: null }] })}`,
              'data: [DONE]',
            ]),
          );
        }
        return Promise.resolve(
          sse([
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'all done' } }] })}`,
            'data: [DONE]',
          ]),
        );
      }),
    );

    const handler = vi.fn(() => 'pong');
    const agent = createAgent({ ...baseAgentConfig, streaming: {} });
    agent.registerFunction({
      name: 'ping',
      description: 'Ping',
      riskTier: 'read',
      parameters: {
        type: 'object',
        properties: { a: { type: 'integer' } },
        required: ['a'],
      },
      handler,
    });

    const result = await agent.run('ping');

    expect(handler).toHaveBeenCalledWith({ a: 1 }, { signal: undefined });
    expect(result.toolCallsExecuted).toHaveLength(1);
    expect(result.toolCallsExecuted[0]!.functionName).toBe('ping');
    expect(result.response).toBe('all done');
  });

  it('fires the deprecated onAuditEvent callback when audit.onEvent is not set', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.resolve(nonStreamResponse(toolCallMessage('ping', {})));
        return Promise.resolve(nonStreamResponse(finalMessage('done')));
      }),
    );
    const onAuditEvent = vi.fn();
    const agent = createAgent({ ...baseAgentConfig, onAuditEvent });
    agent.registerFunction({
      name: 'ping',
      description: 'Ping',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 'pong',
    });

    await agent.run('hi');
    // A tool round records function_requested / validation_passed / function_executed.
    expect(onAuditEvent).toHaveBeenCalled();
  });

  it('prefers audit.onEvent over the deprecated onAuditEvent when both are set', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.resolve(nonStreamResponse(toolCallMessage('ping', {})));
        return Promise.resolve(nonStreamResponse(finalMessage('done')));
      }),
    );
    const onAuditEvent = vi.fn();
    const onEvent = vi.fn();
    const agent = createAgent({ ...baseAgentConfig, onAuditEvent, audit: { onEvent } });
    agent.registerFunction({
      name: 'ping',
      description: 'Ping',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 'pong',
    });

    await agent.run('hi');
    expect(onEvent).toHaveBeenCalled();
    expect(onAuditEvent).not.toHaveBeenCalled();
  });
});
