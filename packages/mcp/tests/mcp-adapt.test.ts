import { describe, expect, it } from 'vitest';

import { adaptMcpTools, type AdaptPolicyWithFilters } from '../src/mcp.js';
import type { FunctionDefinition, RiskTier } from '@forgewisp/core';
import type { McpCallToolResult, McpClient, McpContentItem, McpTool } from '../src/types.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** A fake MCP client that records the last callTool invocation and returns a configured result. */
class FakeClient implements McpClient {
  lastParams: { name: string; arguments?: Record<string, unknown> } | undefined;
  lastOptions: { signal?: AbortSignal } | undefined;
  nextResult: McpCallToolResult = { content: [] };
  shouldThrow: Error | undefined;
  calls = 0;

  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    _resultSchema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<McpCallToolResult> {
    this.calls += 1;
    this.lastParams = params;
    this.lastOptions = options;
    if (this.shouldThrow) return Promise.reject(this.shouldThrow);
    return Promise.resolve(this.nextResult);
  }
}

function tool(name: string, opts: Partial<McpTool> = {}): McpTool {
  return {
    name,
    // `'description' in opts` (not `??`) so an explicit `undefined` stays undefined.
    description: 'description' in opts ? opts.description : `Description for ${name}`,
    inputSchema: opts.inputSchema ?? {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    },
    annotations: opts.annotations,
  };
}

function policy(over: Partial<AdaptPolicyWithFilters> = {}): AdaptPolicyWithFilters {
  return {
    serverName: 'test',
    prefix: 'test',
    defaultTier: 'read',
    tierOverrides: {},
    requestTimeoutMs: undefined,
    ...over,
  };
}

/** Drive a tool's handler with the fake client and return whatever the handler resolves to.
 *  The `client` arg is the same fake the adapter closed over; passed for readability only. */
function runHandler(
  def: FunctionDefinition,
  _client: FakeClient,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  return Promise.resolve(def.handler(args, signal ? { signal } : undefined));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('adaptMcpTools — naming', () => {
  it('prefixes tool names as <prefix>__<tool>', () => {
    const defs = adaptMcpTools(new FakeClient(), [tool('getTime')], policy({ prefix: 'fs' }));
    expect(defs.map((d) => d.name)).toEqual(['fs__getTime']);
  });

  it('sanitizes invalid chars to _ (OpenAI function-name constraint)', () => {
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('weird.name:with/chars')],
      policy({ prefix: 'fs' }),
    );
    expect(defs[0]?.name).toBe('fs__weird_name_with_chars');
  });

  it('caps the prefixed name at 64 chars', () => {
    const longName = 'a'.repeat(80);
    const defs = adaptMcpTools(new FakeClient(), [tool(longName)], policy({ prefix: 'fs' }));
    expect(defs[0]?.name.length).toBeLessThanOrEqual(64);
    expect(defs[0]?.name).toMatch(/^fs__a+(_\d+)?$/);
  });

  it('disambiguates collisions with a numeric suffix', () => {
    // 'a.b', 'a/b', and 'a_b' all sanitize to 'a_b' ('.' and '/' → '_', '_' stays).
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('a.b'), tool('a/b'), tool('a_b')],
      policy({ prefix: 'fs' }),
    );
    const names = defs.map((d) => d.name);
    expect(names).toContain('fs__a_b');
    expect(new Set(names).size).toBe(names.length);
    // Exactly one unsuffixed, the other two suffixed.
    expect(names.filter((n) => n === 'fs__a_b')).toHaveLength(1);
    expect(names.filter((n) => /^fs__a_b_\d+$/.test(n))).toHaveLength(2);
  });

  it('sanitizes the prefix half too (a server name with spaces/dots stays OpenAI-safe)', () => {
    // An unsanitized prefix would yield `my server__t` / `my.server__t`, violating the OpenAI
    // `^[A-Za-z0-9_-]{1,64}$` regex (core's registry only dedup-checks, so it would reach the wire).
    const defs = adaptMcpTools(new FakeClient(), [tool('t')], policy({ prefix: 'my server.name' }));
    expect(defs[0]?.name).toBe('my_server_name__t');
    expect(defs[0]?.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('collapses an empty prefix to a fallback so the name still satisfies the regex', () => {
    const defs = adaptMcpTools(new FakeClient(), [tool('t')], policy({ prefix: '' }));
    expect(defs[0]?.name).toBe('srv__t');
    expect(defs[0]?.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('reserves room for `__` + the tool name when the prefix is very long', () => {
    // A prefix at/above 62 chars used to make `base.slice(0, 64)` yield just the prefix, slicing
    // off `__` and the whole tool half — so every tool collapsed to a numeric suffix. The prefix
    // cap now reserves room for the separator + a tool stub, so the tool name survives.
    const longPrefix = 'p'.repeat(70);
    const defs = adaptMcpTools(new FakeClient(), [tool('getTime')], policy({ prefix: longPrefix }));
    const name = defs[0]?.name ?? '';
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    // The separator and at least part of the tool name are present — the name is not just the prefix.
    expect(name).toMatch(/__get/);
  });

  it('keeps distinct tool names visible when the prefix is long (no collapse to suffixes)', () => {
    const longPrefix = 'p'.repeat(70);
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('getThing'), tool('setThing')],
      policy({ prefix: longPrefix }),
    );
    const names = defs.map((d) => d.name);
    // Both tools keep their tool-name portion (not reduced to a shared prefix + numeric suffix).
    expect(names.some((n) => n.includes('getThing'))).toBe(true);
    expect(names.some((n) => n.includes('setThing'))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('adaptMcpTools — tiers', () => {
  it('defaults to the configured defaultTier', () => {
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('a'), tool('b')],
      policy({ defaultTier: 'write' }),
    );
    expect(defs.every((d) => d.riskTier === 'write')).toBe(true);
  });

  it('applies tierOverrides per original tool name', () => {
    const tiers: Record<string, RiskTier> = {
      deleteThing: 'destructive',
      setThing: 'write',
      getThing: 'read',
    };
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('getThing'), tool('setThing'), tool('deleteThing')],
      policy({ defaultTier: 'read', tierOverrides: tiers }),
    );
    const byBase = Object.fromEntries(defs.map((d) => [d.name.replace(/^test__/, ''), d.riskTier]));
    expect(byBase).toEqual({ getThing: 'read', setThing: 'write', deleteThing: 'destructive' });
  });

  it('defaults to read when nothing is configured', () => {
    const defs = adaptMcpTools(new FakeClient(), [tool('a')], policy());
    expect(defs[0]?.riskTier).toBe('read');
  });
});

describe('adaptMcpTools — filtering', () => {
  it('onlyTools acts as an allowlist', () => {
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('a'), tool('b'), tool('c')],
      policy({ onlyTools: ['a', 'c'] }),
    );
    expect(defs.map((d) => d.name).sort()).toEqual(['test__a', 'test__c']);
  });

  it('excludeTools acts as a blocklist', () => {
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('a'), tool('b'), tool('c')],
      policy({ excludeTools: ['b'] }),
    );
    expect(defs.map((d) => d.name).sort()).toEqual(['test__a', 'test__c']);
  });

  it('onlyTools: [] registers nothing (an explicit empty allowlist is not "no allowlist")', () => {
    // Gating on `allow.size > 0` previously treated `[]` like `undefined` and registered every tool.
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('a'), tool('b'), tool('c')],
      policy({ onlyTools: [] }),
    );
    expect(defs).toEqual([]);
  });

  it('onlyTools: undefined registers all (no allowlist configured)', () => {
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('a'), tool('b'), tool('c')],
      policy({ onlyTools: undefined }),
    );
    expect(defs.map((d) => d.name).sort()).toEqual(['test__a', 'test__b', 'test__c']);
  });
});

describe('adaptMcpTools — schema & description', () => {
  it('passes the raw inputSchema through to parameters', () => {
    const inputSchema = {
      type: 'object',
      properties: { q: { type: 'string', minLength: 1, enum: ['x', 'y'] } },
      required: ['q'],
      additionalProperties: false,
    } as const;
    const defs = adaptMcpTools(new FakeClient(), [tool('search', { inputSchema })], policy());
    expect(defs[0]?.parameters).toEqual(inputSchema);
  });

  it('attributes the tool with the MCP server name in the description', () => {
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('search', { description: 'Search things' })],
      policy({ serverName: 'myserver' }),
    );
    expect(defs[0]?.description).toBe('Search things (MCP server: myserver)');
  });

  it('falls back to the tool name when description is missing', () => {
    const defs = adaptMcpTools(
      new FakeClient(),
      [tool('search', { description: undefined })],
      policy({ serverName: 'myserver' }),
    );
    expect(defs[0]?.description).toBe('search (MCP server: myserver)');
  });
});

describe('adaptMcpTool — handler', () => {
  it('calls the MCP tool by its ORIGINAL (un-prefixed) name and forwards args', async () => {
    const client = new FakeClient();
    const defs = adaptMcpTools(client, [tool('getTime')], policy({ prefix: 'fs' }));
    await runHandler(defs[0]!, client, { x: 'UTC' });
    expect(client.lastParams).toEqual({ name: 'getTime', arguments: { x: 'UTC' } });
  });

  it('forwards an abort signal via callTool options', async () => {
    const client = new FakeClient();
    const defs = adaptMcpTools(client, [tool('getTime')], policy());
    const ac = new AbortController();
    await runHandler(defs[0]!, client, {}, ac.signal);
    expect(client.lastOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes no options when there is no signal and no timeout', async () => {
    const client = new FakeClient();
    const defs = adaptMcpTools(client, [tool('getTime')], policy({ requestTimeoutMs: undefined }));
    await runHandler(defs[0]!, client);
    expect(client.lastOptions).toBeUndefined();
  });

  it('returns structuredContent when present (preferred)', async () => {
    const client = new FakeClient();
    client.nextResult = {
      content: [{ type: 'text', text: 'ignored' }],
      structuredContent: { ok: true, n: 3 },
    };
    const defs = adaptMcpTools(client, [tool('t')], policy());
    await expect(runHandler(defs[0]!, client)).resolves.toEqual({ ok: true, n: 3 });
  });

  it('returns the text string when there is a single text item', async () => {
    const client = new FakeClient();
    client.nextResult = { content: [{ type: 'text', text: 'hello' }] };
    const defs = adaptMcpTools(client, [tool('t')], policy());
    await expect(runHandler(defs[0]!, client)).resolves.toBe('hello');
  });

  it('joins multiple text items with newline', async () => {
    const client = new FakeClient();
    client.nextResult = {
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    };
    const defs = adaptMcpTools(client, [tool('t')], policy());
    await expect(runHandler(defs[0]!, client)).resolves.toBe('a\nb');
  });

  it('returns { content } for mixed/non-text content', async () => {
    const client = new FakeClient();
    const content: McpContentItem[] = [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'b64', mimeType: 'image/png' },
    ];
    client.nextResult = { content };
    const defs = adaptMcpTools(client, [tool('t')], policy());
    await expect(runHandler(defs[0]!, client)).resolves.toEqual({ content });
  });

  it('throws (→ function_errored) when isError is true, using the first text item', async () => {
    const client = new FakeClient();
    client.nextResult = { content: [{ type: 'text', text: 'boom: bad input' }], isError: true };
    const defs = adaptMcpTools(client, [tool('t')], policy());
    await expect(runHandler(defs[0]!, client)).rejects.toThrow('boom: bad input');
  });

  it('throws a generic message when isError has no text item', async () => {
    const client = new FakeClient();
    client.nextResult = {
      content: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
      isError: true,
    };
    const defs = adaptMcpTools(client, [tool('myTool')], policy());
    await expect(runHandler(defs[0]!, client)).rejects.toThrow(/MCP tool "myTool"/);
  });

  it('propagates handler exceptions from the client', async () => {
    const client = new FakeClient();
    client.shouldThrow = new Error('network down');
    const defs = adaptMcpTools(client, [tool('t')], policy());
    await expect(runHandler(defs[0]!, client)).rejects.toThrow('network down');
  });
});
