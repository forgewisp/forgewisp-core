import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// The low-level `Server` (not the high-level `McpServer`) is used here on purpose: it lets us
// register tools with raw JSON-Schema `inputSchema` and a `setRequestHandler(CallToolRequest)`
// handler that reads `req.params.arguments` directly, without pulling `zod` into devDeps.
// (`Server` carries an SDK deprecation hint, which is informational only — not a typecheck error.)
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FunctionDefinition } from '@forgewisp/core';

import { registerMcpServer, createMcpTools } from '../src/mcp.js';
import type { AgentLike } from '../src/types.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** A recording fake agent: implements the `AgentLike` structural subset and remembers calls. */
class FakeAgent implements AgentLike {
  registered = new Map<string, FunctionDefinition>();
  registerFunction(def: FunctionDefinition): void {
    this.registered.set(def.name, def);
  }
  deregisterFunction(name: string): void {
    this.registered.delete(name);
  }
}

/** The two tools our test server exposes. */
const SERVER_TOOLS = [
  {
    name: 'getThing',
    description: 'Get a thing by id',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'deleteThing',
    description: 'Delete a thing by id',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { destructiveHint: true },
  },
];

/** Safely stringify an unknown arg value for a test text payload. */
function str(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x == null) return '';
  return JSON.stringify(x);
}

/** Build an in-memory MCP server exposing the two test tools and connect it. */
async function startServer(): Promise<{ server: Server; clientTransport: Transport }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = new Server(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: SERVER_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const name = req.params.name;
    const args: Record<string, unknown> = req.params.arguments ?? {};
    if (name === 'getThing') {
      return { content: [{ type: 'text', text: `got:${str(args.id)}` }] };
    }
    if (name === 'deleteThing') {
      return { content: [{ type: 'text', text: `deleted:${str(args.id)}` }] };
    }
    return { content: [{ type: 'text', text: `unknown:${name}` }], isError: true };
  });

  await server.connect(serverTransport);
  return { server, clientTransport };
}

const baseConfig = {
  name: 'srv',
  url: 'http://unused-in-memory-test',
  tierOverrides: { deleteThing: 'destructive' as const },
  // The server exposes a destructive tool, so the agent must have `onConfirmRequired` configured;
  // `hasConfirmation: true` tells `registerMcpServer` the preflight is satisfied.
  hasConfirmation: true,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('registerMcpServer — integration via InMemoryTransport', () => {
  it('registers every exposed tool under prefixed names', async () => {
    const { server, clientTransport } = await startServer();
    const agent = new FakeAgent();

    const handle = await registerMcpServer(agent, baseConfig, { transport: clientTransport });

    expect(handle.toolNames.sort()).toEqual(['srv__deleteThing', 'srv__getThing']);
    expect(Array.from(agent.registered.keys()).sort()).toEqual([
      'srv__deleteThing',
      'srv__getThing',
    ]);

    await handle.close();
    await server.close();
  });

  it('classifies tools via tierOverrides', async () => {
    const { server, clientTransport } = await startServer();
    const agent = new FakeAgent();

    const handle = await registerMcpServer(agent, baseConfig, { transport: clientTransport });
    expect(agent.registered.get('srv__getThing')?.riskTier).toBe('read');
    expect(agent.registered.get('srv__deleteThing')?.riskTier).toBe('destructive');

    await handle.close();
    await server.close();
  });

  it('flows a tool call through to the server and returns the flattened result', async () => {
    const { server, clientTransport } = await startServer();
    const agent = new FakeAgent();

    const handle = await registerMcpServer(agent, baseConfig, { transport: clientTransport });
    const def = agent.registered.get('srv__getThing')!;
    const result = await def.handler({ id: '42' });
    expect(result).toBe('got:42');

    await handle.close();
    await server.close();
  });

  it('close() deregisters every tool and disconnects', async () => {
    const { server, clientTransport } = await startServer();
    const agent = new FakeAgent();

    const handle = await registerMcpServer(agent, baseConfig, { transport: clientTransport });
    expect(agent.registered.size).toBe(2);

    await handle.close();
    expect(agent.registered.size).toBe(0);

    // Calling close() again is a no-op.
    await expect(handle.close()).resolves.toBeUndefined();
    await server.close();
  });

  it('throws up front (preflight) and registers nothing when a destructive tool lacks hasConfirmation', async () => {
    const { server, clientTransport } = await startServer();
    const agent = new FakeAgent();

    await expect(
      registerMcpServer(
        agent,
        { ...baseConfig, hasConfirmation: false },
        { transport: clientTransport },
      ),
    ).rejects.toThrow(/hasConfirmation/);

    // Nothing was registered (no partial state).
    expect(agent.registered.size).toBe(0);
    await server.close();
  });

  it('registers destructive tools when hasConfirmation is true', async () => {
    const { server, clientTransport } = await startServer();
    const agent = new FakeAgent();

    const handle = await registerMcpServer(
      agent,
      { ...baseConfig, hasConfirmation: true },
      {
        transport: clientTransport,
      },
    );
    expect(agent.registered.has('srv__deleteThing')).toBe(true);

    await handle.close();
    await server.close();
  });
});

describe('createMcpTools — without an agent', () => {
  it('returns adapted FunctionDefinitions and a working close', async () => {
    const { server, clientTransport } = await startServer();

    const { tools, close } = await createMcpTools(baseConfig, { transport: clientTransport });
    expect(tools.map((t) => t.name).sort()).toEqual(['srv__deleteThing', 'srv__getThing']);

    // The adapted handler still works against the live client.
    const getThing = tools.find((t) => t.name === 'srv__getThing')!;
    await expect(getThing.handler({ id: '7' })).resolves.toBe('got:7');

    await close();
    await server.close();
  });
});

describe('registerMcpServer — onlyTools filtering', () => {
  it('skips tools not in onlyTools', async () => {
    const { server, clientTransport } = await startServer();
    const agent = new FakeAgent();

    const handle = await registerMcpServer(
      agent,
      { ...baseConfig, onlyTools: ['getThing'], hasConfirmation: true },
      { transport: clientTransport },
    );
    expect(handle.toolNames).toEqual(['srv__getThing']);
    expect(agent.registered.has('srv__deleteThing')).toBe(false);

    await handle.close();
    await server.close();
  });
});
