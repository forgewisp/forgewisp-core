import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAgent, defineToolSet } from '../src/index.js';
import type { FunctionDefinition, ForgewispConfig, ToolSet } from '../src/types.js';
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

function finalMessage(text: string): LLMMessage {
  return { role: 'assistant', content: text };
}

function readTool(name: string, result: unknown): FunctionDefinition {
  return {
    name,
    description: name,
    riskTier: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: () => result,
  };
}

describe('defineToolSet', () => {
  it('round-trips name, description, and tools', () => {
    const a = readTool('a', 1);
    const b = readTool('b', 2);
    const set = defineToolSet({ name: 'demo', description: 'd', tools: [a, b] });
    expect(set.name).toBe('demo');
    expect(set.description).toBe('d');
    expect(set.tools).toEqual([a, b]);
  });

  it('makes description optional', () => {
    const set = defineToolSet({ name: 'bare', tools: [readTool('a', 1)] });
    expect(set.description).toBeUndefined();
  });

  it('accepts a heterogeneous tool tuple without a cast', () => {
    // A ToolSet built from tools with differing TArgs shapes — this compiles with no
    // `as unknown as` thanks to the `FunctionDefinition<never>` covariant read type.
    const stringTool: FunctionDefinition<{ prefix?: string }> = {
      name: 'stringTool',
      description: 'string arg',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: (args) => args.prefix ?? '',
    };
    const numberTool: FunctionDefinition<{ count: number }> = {
      name: 'numberTool',
      description: 'number arg',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: (args) => args.count,
    };
    const set: ToolSet = defineToolSet({ name: 'mixed', tools: [stringTool, numberTool] });
    expect(set.tools.map((t) => t.name)).toEqual(['stringTool', 'numberTool']);
  });

  it('composes from another set by spreading .tools', () => {
    const inner = defineToolSet({ name: 'inner', tools: [readTool('a', 1), readTool('b', 2)] });
    const outer = defineToolSet({ name: 'outer', tools: [...inner.tools, readTool('c', 3)] });
    expect(outer.tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('ForgewispAgent.registerToolSet', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers every tool in the set so they are exposed to the LLM', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(nonStreamResponse(finalMessage('done'))));
    vi.stubGlobal('fetch', fetchMock);

    const agent = createAgent(baseAgentConfig);
    agent.registerToolSet(
      defineToolSet({ name: 'pair', tools: [readTool('alpha', 1), readTool('beta', 2)] }),
    );

    await agent.run('hi');

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as Record<string, unknown>;
    const tools = body['tools'] as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).toEqual(['alpha', 'beta']);
    expect(body['tool_choice']).toBe('auto');
  });

  it('throws at registration time when a set contains a write tool without onConfirmRequired', () => {
    const agent = createAgent(baseAgentConfig);
    const writeTool: FunctionDefinition = {
      name: 'w',
      description: 'W',
      riskTier: 'write',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 1,
    };
    expect(() =>
      agent.registerToolSet(
        defineToolSet({ name: 'has-write', tools: [readTool('r', 1), writeTool] }),
      ),
    ).toThrow('onConfirmRequired');
  });

  it('registers write tools when onConfirmRequired is configured', () => {
    const agent = createAgent({
      ...baseAgentConfig,
      onConfirmRequired: () => Promise.resolve(true),
    });
    const writeTool: FunctionDefinition = {
      name: 'w',
      description: 'W',
      riskTier: 'write',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 1,
    };
    expect(() =>
      agent.registerToolSet(defineToolSet({ name: 'has-write', tools: [writeTool] })),
    ).not.toThrow();
  });
});
