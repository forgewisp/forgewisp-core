import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import type { FunctionDefinition } from '@forgewisp/core';

import { registerMcpServer, createMcpTools } from '../src/mcp.js';
import type { AgentLike } from '../src/types.js';

// ─── Test scaffolding ─────────────────────────────────────────────────────────
//
// The OAuth flow is unit-tested without HTTP by wrapping a real in-memory message pipe (the linked
// `InMemoryTransport` pair to an in-process `Server`) in an `OAuthGatedTransport` that mimics the
// SDK `StreamableHTTPClientTransport` auth contract just enough to exercise the adapter's state
// machine:
//
//   - `start()` returns 'pending' semantics: when the provider holds no tokens it calls
//     `redirectToAuthorization(url)` and throws `UnauthorizedError` (exactly as the SDK does before
//     throwing from `connect`).
//   - `finishAuth(code)` simulates the code exchange by saving tokens into the provider (so a fresh
//     transport's `start()` finds tokens and proceeds) — mirroring production, where finishAuth
//     exchanges the code and a fresh transport reads the saved token.
//
// A *factory* seam (`options.transport = () => gated`) is used so `finishAuth`'s fresh-transport
// reconnect gets a new gated instance sharing the one in-memory pipe (a single-instance seam could
// not be re-`connect`ed — the SDK can't either, which is the whole reason the adapter builds a fresh
// transport on resume).

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

function str(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x == null) return '';
  return JSON.stringify(x);
}

/** Start an in-process MCP server exposing the two test tools; returns the *client*-side inner
 *  transport of the linked pair (the server holds the other side). */
async function startServer(): Promise<{ server: Server; clientInner: Transport }> {
  const [clientInner, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = new Server(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: SERVER_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const name = req.params.name;
    const args: Record<string, unknown> = req.params.arguments ?? {};
    if (name === 'getThing') return { content: [{ type: 'text', text: `got:${str(args.id)}` }] };
    if (name === 'deleteThing')
      return { content: [{ type: 'text', text: `deleted:${str(args.id)}` }] };
    return { content: [{ type: 'text', text: `unknown:${name}` }], isError: true };
  });

  await server.connect(serverTransport);
  return { server, clientInner };
}

/** A fake `OAuthClientProvider` that records the redirect and stores tokens/client info in memory.
 *  Methods are non-async returning plain values — the SDK `auth()` flow `await`s them, which works on
 *  non-promise values. Backing fields are underscore-prefixed so they don't collide with the
 *  interface methods (`tokens`/`clientInformation`/`codeVerifier`). */
class FakeProvider implements OAuthClientProvider {
  readonly redirectUrl = new URL('http://localhost:5173/oauth-callback.html');
  readonly redirectCalls: URL[] = [];
  private _tokens?: OAuthTokens;
  private _clientInfo?: OAuthClientInformationMixed;
  private _verifier = 'test-verifier';
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: 'Forgewisp MCP test',
    redirect_uris: [String(this.redirectUrl)],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
  };

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._clientInfo;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._clientInfo = info;
  }
  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
  }
  redirectToAuthorization(url: URL): void {
    this.redirectCalls.push(url);
  }
  saveCodeVerifier(codeVerifier: string): void {
    this._verifier = codeVerifier;
  }
  codeVerifier(): string {
    return this._verifier;
  }
  invalidateCredentials(): void {
    this._tokens = undefined;
  }
}

/**
 * A transport that gates `start()` behind OAuth, mirroring `StreamableHTTPClientTransport`:
 *   - no tokens in the provider → call `redirectToAuthorization(url)` and throw `UnauthorizedError`;
 *   - tokens present → wire the shared inner transport's callbacks to ours and (once, shared across
 *     gated instances) start the inner transport.
 *
 * `close()` is intentionally a no-op: the shared inner pipe must survive the failed first connect
 * (the SDK calls `transport.close()` on the failed connect) and the `finishAuth` reconnect, so the
 * fresh gated transport can reuse it. Test cleanup closes the server, which closes both ends.
 */
class OAuthGatedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: Transport,
    private readonly provider: FakeProvider,
    private readonly shared: { innerStarted: boolean },
  ) {}

  async start(): Promise<void> {
    const tokens = this.provider.tokens();
    if (!tokens) {
      this.provider.redirectToAuthorization(new URL('https://auth.example/authorize'));
      throw new UnauthorizedError('need auth');
    }
    // Tokens present (real flow: saved by finishAuth). Forward the inner pipe to our callbacks
    // (the Client sets onclose/onerror/onmessage before calling start) and start the inner once.
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (e: Error) => this.onerror?.(e);
    this.inner.onmessage = (m: JSONRPCMessage, extra?: MessageExtraInfo) => {
      // The SDK invokes onmessage with the concrete message subtype; forward to our generic callback.
      this.onmessage?.(m, extra);
    };
    if (!this.shared.innerStarted) {
      this.shared.innerStarted = true;
      await this.inner.start();
    }
  }

  finishAuth(authorizationCode: string): Promise<void> {
    // Simulate the code exchange: save a token so a fresh transport's start() proceeds. The code is
    // unused in the fake (the real exchange hits the authorization server), but we fold it into the
    // token so the value is observably distinct per finishAuth call.
    void authorizationCode;
    this.provider.saveTokens({
      access_token: `fake-token:${authorizationCode}`,
      token_type: 'bearer',
    });
    return Promise.resolve();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    /* no-op — see class doc: the shared inner pipe must outlive a failed connect / reconnect */
    return Promise.resolve();
  }

  terminateSession(): Promise<void> {
    return Promise.resolve();
  }
}

/** Build a factory seam producing fresh `OAuthGatedTransport`s that all share one inner pipe. */
function makeTransportFactory(
  inner: Transport,
  provider: FakeProvider,
): { factory: () => OAuthGatedTransport; shared: { innerStarted: boolean } } {
  const shared = { innerStarted: false };
  const factory = () => new OAuthGatedTransport(inner, provider, shared);
  return { factory, shared };
}

const baseOAuthConfig = (provider: FakeProvider) => ({
  name: 'srv',
  url: 'http://unused-in-memory-test',
  authProvider: provider,
  tierOverrides: { deleteThing: 'destructive' as const },
  hasConfirmation: true,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createMcpTools — OAuth pending → finishAuth', () => {
  it('returns authState "pending" with no tools when the server requires auth', async () => {
    const { server, clientInner } = await startServer();
    const provider = new FakeProvider();
    const { factory } = makeTransportFactory(clientInner, provider);

    const result = await createMcpTools(baseOAuthConfig(provider), { transport: factory });

    expect(result.authState).toBe('pending');
    expect(result.tools).toEqual([]);
    expect(provider.redirectCalls).toHaveLength(1);
    expect(provider.redirectCalls[0]?.href).toBe('https://auth.example/authorize');

    await result.close();
    await server.close();
  });

  it('finishAuth exchanges the code, reconnects, and populates tools', async () => {
    const { server, clientInner } = await startServer();
    const provider = new FakeProvider();
    const { factory } = makeTransportFactory(clientInner, provider);

    const result = await createMcpTools(baseOAuthConfig(provider), { transport: factory });
    expect(result.authState).toBe('pending');

    await result.finishAuth('the-code');
    expect(result.authState).toBe('authorized');
    expect(result.tools.map((t) => t.name).sort()).toEqual(['srv__deleteThing', 'srv__getThing']);

    // The adapted handler flows a call through the (reconnected) in-memory server.
    const getThing = result.tools.find((t) => t.name === 'srv__getThing')!;
    await expect(getThing.handler({ id: '42' })).resolves.toBe('got:42');

    await result.close();
    await server.close();
  });

  it('finishAuth is idempotent (a second call is a no-op)', async () => {
    const { server, clientInner } = await startServer();
    const provider = new FakeProvider();
    const { factory } = makeTransportFactory(clientInner, provider);

    const result = await createMcpTools(baseOAuthConfig(provider), { transport: factory });
    await result.finishAuth('the-code');
    expect(result.authState).toBe('authorized');
    expect(provider.redirectCalls).toHaveLength(1); // only the initial redirect

    await expect(result.finishAuth('the-code')).resolves.toBeUndefined();
    expect(result.authState).toBe('authorized');
    expect(provider.redirectCalls).toHaveLength(1); // no second redirect

    await result.close();
    await server.close();
  });

  it('finishAuth after close() throws', async () => {
    const { server, clientInner } = await startServer();
    const provider = new FakeProvider();
    const { factory } = makeTransportFactory(clientInner, provider);

    const result = await createMcpTools(baseOAuthConfig(provider), { transport: factory });
    await result.close();
    await expect(result.finishAuth('the-code')).rejects.toThrow(/close/);

    await server.close();
  });

  it('authorizationCode resume path connects in one shot (no pending state)', async () => {
    const { server, clientInner } = await startServer();
    const provider = new FakeProvider();
    const { factory } = makeTransportFactory(clientInner, provider);

    // Resume: the code is exchanged on a fresh transport before connecting, so connect reads the
    // saved token and returns authorized directly.
    const result = await createMcpTools(baseOAuthConfig(provider), {
      transport: factory,
      authorizationCode: 'resume-code',
    });

    expect(result.authState).toBe('authorized');
    expect(result.tools.map((t) => t.name).sort()).toEqual(['srv__deleteThing', 'srv__getThing']);
    expect(provider.redirectCalls).toHaveLength(0); // no redirect on the resume path

    const getThing = result.tools.find((t) => t.name === 'srv__getThing')!;
    await expect(getThing.handler({ id: '7' })).resolves.toBe('got:7');

    await result.close();
    await server.close();
  });
});

describe('registerMcpServer — OAuth pending → finishAuth', () => {
  it('registers nothing while pending; finishAuth runs the preflight and registers', async () => {
    const { server, clientInner } = await startServer();
    const agent = new FakeAgent();
    const provider = new FakeProvider();
    const { factory } = makeTransportFactory(clientInner, provider);

    const handle = await registerMcpServer(agent, baseOAuthConfig(provider), {
      transport: factory,
    });
    expect(handle.authState).toBe('pending');
    expect(handle.toolNames).toEqual([]);
    expect(agent.registered.size).toBe(0);

    await handle.finishAuth('the-code');
    expect(handle.authState).toBe('authorized');
    expect(handle.toolNames.sort()).toEqual(['srv__deleteThing', 'srv__getThing']);
    expect(Array.from(agent.registered.keys()).sort()).toEqual([
      'srv__deleteThing',
      'srv__getThing',
    ]);

    await handle.close();
    expect(agent.registered.size).toBe(0);
    await server.close();
  });

  it('finishAuth throws the preflight error (and registers nothing) when hasConfirmation is false', async () => {
    const { server, clientInner } = await startServer();
    const agent = new FakeAgent();
    const provider = new FakeProvider();
    const { factory } = makeTransportFactory(clientInner, provider);

    const handle = await registerMcpServer(
      agent,
      { ...baseOAuthConfig(provider), hasConfirmation: false },
      { transport: factory },
    );
    expect(handle.authState).toBe('pending');

    await expect(handle.finishAuth('the-code')).rejects.toThrow(/hasConfirmation/);
    expect(agent.registered.size).toBe(0);

    await server.close();
  });
});
