/**
 * MCP → Forgewisp adapter.
 *
 * Connects to an MCP server over the Streamable HTTP transport, lists its tools, and adapts
 * each into a Forgewisp `FunctionDefinition` that is registered through the agent's existing
 * `registerFunction` path. Because registration goes through core unchanged, the registry,
 * Ajv validation, the two-phase executor, the `onConfirmRequired` confirmation invariant, the
 * audit log, and `runToolLoop` all apply to MCP tools for free — MCP becomes just another source
 * of `FunctionDefinition`s.
 *
 * The adapter is layered so the mapping is unit-testable without a network:
 *   - `adaptMcpTool` / `adaptMcpTools` — pure given a `McpClient` (the test seam; a plain fake
 *     object implementing `callTool` is enough).
 *   - `connectMcpServer` — builds the SDK `Client` + `StreamableHTTPClientTransport`.
 *   - `createMcpTools` / `registerMcpServer` — the public wiring.
 *
 * ── Schema handling ──────────────────────────────────────────────────────────
 * MCP `inputSchema` is full draft-07 JSON Schema. Forgewisp's `JSONSchema` type (in core) is a
 * deliberately narrow subset enforcing strict hand-authored schemas in `@forgewisp/bundled-tools`;
 * we do NOT widen it. The adapter casts the raw `inputSchema` to `JSONSchema` at the boundary.
 * Runtime is correct: core's Ajv is `strict: false` and validates draft-07 (`$ref`/`enum`/`oneOf`
 * etc.), the compiled validator is cached per schema-object identity, and the wire payload sent
 * to the LLM carries the full schema, which OpenAI-compatible models accept. Limitation: any
 * external `$ref` (not present in well-formed MCP schemas) won't resolve.
 *
 * ── Risk tiers ────────────────────────────────────────────────────────────────
 * MCP has no risk-tier concept. Tiers come entirely from `McpServerConfig` (`defaultTier` +
 * `tierOverrides`); MCP `annotations.readOnlyHint`/`destructiveHint` are informational only and
 * deliberately NOT auto-mapped — the consumer owns the security boundary.
 *
 * ── Abort ─────────────────────────────────────────────────────────────────────
 * The parent run's `AbortSignal` is threaded into handlers by core's executor via `ToolContext`.
 * The handler forwards it to `client.callTool` (merged with a per-server timeout), so aborting
 * the parent run aborts in-flight MCP calls.
 *
 * ── OAuth ─────────────────────────────────────────────────────────────────────
 * `McpServerConfig.authProvider` (an SDK `OAuthClientProvider`) takes precedence over `apiKey` and
 * drives the full OAuth 2.1 authorization-code + PKCE flow (RFC 9728 / 8414 discovery, dynamic client
 * registration, token exchange, refresh) via the SDK transport — the consumer only implements the
 * provider (browser-redirect plumbing + token storage). `client/auth.js` is dynamically imported
 * only on the OAuth path; non-OAuth consumers never load it.
 *
 * State machine: the first `connect` that needs auth has the SDK call
 * `authProvider.redirectToAuthorization(url)` and then throw `UnauthorizedError` from `connect`.
 * `Client.connect` catches that, calls `void this.close()`, and rethrows. The transport is now
 * *spent* — `close()` aborts its `AbortController` but does not null it, so a second `start()`
 * throws "already started". **The same transport cannot be re-`connect`ed.** So this adapter
 * catches `UnauthorizedError` (via `instanceof`, dynamically importing the class only on this path —
 * the SDK's error doesn't set a custom `name`, so a name check won't work) and returns
 * `authState: 'pending'` (empty tools) instead of throwing, keeping the spent transport+client only
 * long enough to call `transport.finishAuth(code)` (which just calls `auth()` to exchange the code
 * and save tokens into the provider — it does not require `start()`). `finishAuth` then builds a
 * **fresh** transport + client whose `connect` reads the saved token via `provider.tokens()` and
 * succeeds. The same "finishAuth-then-fresh-connect" pattern powers the resume path
 * (`options.authorizationCode`), which exchanges the code on a single fresh transport *before*
 * connecting.
 *
 * For `registerMcpServer`, the `hasConfirmation` preflight runs only once tools are listed — i.e.
 * after auth completes (deferred when `authState` is `'pending'`), mirroring the non-OAuth path.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FunctionDefinition, JSONSchema, RiskTier, ToolContext } from '@forgewisp/core';
// Read the version from this package's own package.json so the SDK client identity (sent to
// every MCP server on every connect) tracks the lockstep version bump automatically, instead of a
// hardcoded string that drifts on every release. Bundled into dist at build time.
import pkg from '../package.json';

import type {
  AgentLike,
  McpAuthState,
  McpCallToolResult,
  McpClient,
  McpConnectOptions,
  McpContentItem,
  McpServerConfig,
  McpServerHandle,
  McpTool,
} from './types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_OPENAI_TOOL_NAME = 64;
const CLIENT_INFO = { name: 'forgewisp-mcp', version: pkg.version } as const;

// ─── OAuth helpers ───────────────────────────────────────────────────────────

/**
 * A transport that may carry an OAuth `finishAuth(code)` method (the SDK's
 * `StreamableHTTPClientTransport` does; injected test transports may). `terminateSession` is also
 * optional — present on the Streamable HTTP transport, absent on `InMemoryTransport`. Both are
 * optional because non-OAuth transports don't implement them.
 */
interface AuthTransport extends Transport {
  finishAuth?(authorizationCode: string): Promise<void>;
  terminateSession?(): Promise<void>;
}

// ─── Abort helpers ───────────────────────────────────────────────────────────

/**
 * Combine an external `AbortSignal` (the parent run's, from `ToolContext`) with a per-call
 * timeout into a single signal. Returns `undefined` when neither is in play. Mirrors the
 * `mergeAbortSignals` pattern in `packages/core/src/http.ts` (core's helper isn't exported, so
 * a minimal local copy lives here).
 *
 * Returns a `cleanup` that MUST be called once the operation bearing the signal completes
 * (in a `finally`), so the `setTimeout` timer and any external-`abort` listener are released
 * promptly instead of lingering for the full `timeoutMs` (and, for the listener, until the
 * parent run's signal is GC'd). Without the cleanup, a chatty run would accumulate one pending
 * timer + one `once` listener on the parent signal per MCP call.
 */
interface TimeoutHandle {
  signal: AbortSignal | undefined;
  cleanup: () => void;
}

function withTimeout(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): TimeoutHandle {
  const hasTimeout = timeoutMs !== undefined && timeoutMs > 0;
  if (!hasTimeout) return { signal: external, cleanup: () => {} };

  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error('[Forgewisp MCP] call timed out.')),
    timeoutMs,
  );
  const propagate = (): void => {
    clearTimeout(timer);
    ctrl.abort((external as AbortSignal & { reason?: unknown }).reason ?? new Error('Aborted'));
  };

  if (external) {
    if (external.aborted) {
      propagate();
    } else {
      external.addEventListener('abort', propagate, { once: true });
    }
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', propagate);
    },
  };
}

// ─── Name sanitization ───────────────────────────────────────────────────────

/**
 * Rewrite a name segment into chars safe for OpenAI's function-name constraint
 * (`^[A-Za-z0-9_-]{1,64}$`). Invalid chars become `_`; the result is truncated to `maxLen` (the
 * tool-name segment is truncated to leave room for a collision suffix added by `adaptMcpTools`).
 * An empty/blank segment collapses to `fallback`.
 */
function sanitizeSegment(raw: string, maxLen: number, fallback: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, maxLen) || fallback;
}

/** Sanitize the tool-name half of the registered name (truncated to leave room for a suffix). */
function sanitizeToolName(raw: string): string {
  return sanitizeSegment(raw, MAX_OPENAI_TOOL_NAME - 4, 'tool');
}

// ─── Result flattening ───────────────────────────────────────────────────────

/**
 * Reduce an MCP `callTool` result to a single JSON-serializable value for core's loop, which
 * serializes handler results via `JSON.stringify` (with a non-serializable fallback). Order:
 *   1. `structuredContent` (machine-readable JSON) — preferred when present.
 *   2. Exactly one `text` item → its `.text` string.
 *   3. All items are `text` → joined with `\n`.
 *   4. Otherwise → `{ content }` (plain JSON-serializable; image/audio data is base64).
 */
function flattenResult(result: McpCallToolResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  const items: McpContentItem[] = result.content ?? [];
  const textItems = items.filter((i) => i.type === 'text');
  if (items.length === 1 && textItems.length === 1) {
    return textItems[0]?.text ?? '';
  }
  if (textItems.length > 0 && textItems.length === items.length) {
    return textItems.map((t) => t.text ?? '').join('\n');
  }
  return { content: result.content };
}

// ─── Adapt policy ────────────────────────────────────────────────────────────

interface AdaptPolicy {
  serverName: string;
  prefix: string;
  defaultTier: RiskTier;
  tierOverrides: Record<string, RiskTier>;
  requestTimeoutMs?: number;
}

function resolveTier(toolName: string, policy: AdaptPolicy): RiskTier {
  return policy.tierOverrides[toolName] ?? policy.defaultTier ?? 'read';
}

// ─── Pure adapter ───────────────────────────────────────────────────────────

/**
 * Adapt a single MCP tool into a Forgewisp `FunctionDefinition`. The handler closes over the
 * `client` and forwards `(args, { signal })` to `client.callTool`, calling the tool by its
 * ORIGINAL (un-prefixed) name so the MCP server sees the right handler. Throws on `isError` so
 * core's executor records `function_errored`.
 *
 * `taken` is the set of already-issued prefixed names (within this server) so collisions after
 * sanitization/truncation get a numeric suffix.
 */
function adaptMcpTool(
  client: McpClient,
  tool: McpTool,
  policy: AdaptPolicy,
  taken: Set<string>,
): FunctionDefinition {
  // Build a name that prioritizes the tool half over the prefix when the two don't both fit in
  // OpenAI's 64-char limit. The tool name is what the LLM disambiguates on, so it wins: reserve
  // `__` + the (capped) tool name first, then give the prefix whatever room remains. A long prefix
  // (e.g. a 60+-char server name) is truncated rather than crowding the tool out of the name
  // entirely — which previously made `base.slice(0, 64)` yield just the prefix, slicing off `__`
  // and the whole tool half so every tool collapsed to a numeric suffix, hiding the tool identity.
  const toolPart = sanitizeToolName(tool.name);
  const prefixBudget = Math.max(0, MAX_OPENAI_TOOL_NAME - '__'.length - toolPart.length);
  const prefixPart = sanitizeSegment(policy.prefix, prefixBudget, 'srv');
  const base = `${prefixPart}__${toolPart}`;
  let name = base.slice(0, MAX_OPENAI_TOOL_NAME);
  // Disambiguate collisions (different MCP tool names that sanitize to the same prefixed name).
  if (taken.has(name)) {
    let n = 2;
    do {
      name = `${base.slice(0, MAX_OPENAI_TOOL_NAME - String(n).length - 1)}_${n}`;
      n += 1;
    } while (taken.has(name));
  }
  taken.add(name);

  const description = `${tool.description ?? tool.name} (MCP server: ${policy.serverName})`;
  const riskTier = resolveTier(tool.name, policy);

  // Cast: MCP `inputSchema` is full draft-07; core's `JSONSchema` is a narrow subset. See the
  // file header — runtime validation (Ajv `strict: false`) and the wire payload both accept it.
  const parameters = (tool.inputSchema ?? {
    type: 'object',
    properties: {},
  }) as unknown as JSONSchema;

  return {
    name,
    description,
    parameters,
    riskTier,
    handler: async (args: Record<string, unknown>, context?: ToolContext) => {
      const { signal, cleanup } = withTimeout(context?.signal, policy.requestTimeoutMs);
      try {
        const result = await client.callTool(
          { name: tool.name, arguments: args },
          undefined,
          signal ? { signal } : undefined,
        );
        if (result.isError) {
          const firstText = result.content?.find((i) => i.type === 'text');
          throw new Error(firstText?.text ?? `MCP tool "${tool.name}" returned an error`);
        }
        return flattenResult(result);
      } finally {
        // Release the timeout timer + external-`abort` listener promptly (see `withTimeout`).
        cleanup();
      }
    },
  };
}

/** Adapt policy extended with the `onlyTools`/`excludeTools` filters from `McpServerConfig`. */
export interface AdaptPolicyWithFilters extends AdaptPolicy {
  onlyTools?: string[];
  excludeTools?: string[];
}

/**
 * Filter and adapt a server's tools into `FunctionDefinition`s. Applies `onlyTools`/`excludeTools`
 * and assigns unique prefixed names. Pure given the `client` — the unit-test seam.
 */
export function adaptMcpTools(
  client: McpClient,
  tools: readonly McpTool[],
  policy: AdaptPolicyWithFilters,
): FunctionDefinition[] {
  // `onlyTools: undefined` → register all (no allowlist). `onlyTools: []` → an explicit empty
  // allowlist → register none. Gating on `allow.size > 0` conflated the two and registered every
  // tool when the caller passed an empty array (the inverse of the allowlist intent).
  const allow = policy.onlyTools !== undefined ? new Set(policy.onlyTools) : undefined;
  const deny = new Set(policy.excludeTools ?? []);
  const taken = new Set<string>();
  const out: FunctionDefinition[] = [];
  for (const tool of tools) {
    if (allow !== undefined && !allow.has(tool.name)) continue;
    if (deny.has(tool.name)) continue;
    out.push(adaptMcpTool(client, tool, policy, taken));
  }
  return out;
}

// ─── Connection ──────────────────────────────────────────────────────────────

/**
 * Adapt the SDK `Client` to the minimal `McpClient` the pure adapter depends on. The SDK's
 * `callTool` return type is a union that also includes a task-async variant (`{ toolResult }`
 * with no `content`); we never invoke task-based execution, so at runtime we always get the
 * `content` variant. The cast lands on that single variant and keeps the union out of the pure
 * adapter's types (so unit tests can use a plain fake object).
 */
function wrapClient(client: Client): McpClient {
  return {
    // Always pass `undefined` for the result schema (we don't request output-schema validation),
    // which sidesteps the SDK's Zod-typed `resultSchema` parameter.
    callTool: (params, _resultSchema, options) =>
      client.callTool(params, undefined, options) as unknown as Promise<McpCallToolResult>,
  };
}

/** Resolve the effective policy fields from a config. */
function policyFromConfig(config: McpServerConfig): AdaptPolicyWithFilters {
  return {
    serverName: config.name,
    prefix: config.toolNamePrefix ?? config.name,
    defaultTier: config.defaultTier ?? 'read',
    tierOverrides: config.tierOverrides ?? {},
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    onlyTools: config.onlyTools,
    excludeTools: config.excludeTools,
  };
}

interface ConnectedServer {
  client: Client;
  transport: AuthTransport;
  authState: McpAuthState;
  close: () => Promise<void>;
}

/**
 * Build a transport for `config`. When `override` is given (the `@internal` test seam), use it as-is.
 * Otherwise dynamically import `StreamableHTTPClientTransport` (so the transport module, which
 * references browser-native `EventSource`, is only evaluated when actually connecting over HTTP)
 * and construct it from `config.url`:
 *   - `authProvider` set → `{ authProvider }` (the SDK transport manages `Authorization` via the
 *     provider's tokens; `apiKey` is ignored — the two are mutually exclusive).
 *   - else `apiKey` set → `{ requestInit: { headers: { Authorization: Bearer <apiKey> } } }`
 *     (header omitted entirely when unset, mirroring core's `HttpClient`).
 */
async function buildTransport(
  config: McpServerConfig,
  override?: Transport,
): Promise<AuthTransport> {
  // `AuthTransport` only adds optional `finishAuth`/`terminateSession` on top of `Transport`, so a
  // plain `Transport` (or the SDK transport, which implements both) is structurally assignable to it
  // — no cast needed.
  if (override) return override;
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  // `authProvider` and `apiKey` are mutually exclusive; authProvider wins (the SDK transport manages
  // the Authorization header from the provider's tokens). The header is omitted entirely when neither
  // is set, so no-auth/proxy endpoints work.
  const opts: { authProvider?: OAuthClientProvider; requestInit?: RequestInit } = {};
  if (config.authProvider) {
    opts.authProvider = config.authProvider;
  } else if (config.apiKey) {
    opts.requestInit = { headers: { Authorization: `Bearer ${config.apiKey}` } };
  }
  return new StreamableHTTPClientTransport(new URL(config.url), opts);
}

/**
 * Connect `client` to `transport`, returning the resulting auth state. When `authorizationCode` is
 * provided (the resume path, only with `authProvider`), it is exchanged on the transport via
 * `finishAuth` *before* connecting — the subsequent `connect` reads the saved token and succeeds.
 *
 * On a plain connect with `authProvider`, an `UnauthorizedError` from `client.connect` means the SDK
 * already called `redirectToAuthorization` and the transport is spent — translate that to
 * `'pending'` rather than throwing. The resume path never returns `'pending'`: it rethrows (a code
 * that doesn't yield a token is a hard failure, not an interactive redirect).
 */
async function connectClient(
  client: Client,
  transport: AuthTransport,
  config: McpServerConfig,
  authorizationCode?: string,
  signal?: AbortSignal,
): Promise<McpAuthState> {
  if (authorizationCode && config.authProvider) {
    // The SDK transport's `finishAuth(code)` only calls `auth()` (token exchange) — its signature
    // takes no AbortSignal, so the per-call timeout can't cover the exchange itself; the subsequent
    // `client.connect` below is what the signal bounds.
    await transport.finishAuth?.(authorizationCode);
  }
  try {
    await client.connect(transport, signal ? { signal } : undefined);
    return 'authorized';
  } catch (err) {
    if (config.authProvider && !authorizationCode) {
      // The SDK's `UnauthorizedError` doesn't set a custom `name` (it stays `'Error'`), so a
      // name-based check can't detect it — use `instanceof`. The class is dynamically imported here,
      // *only* on the OAuth-pending path (when connect throws with an authProvider), so the non-OAuth
      // path never loads `client/auth.js`. The SDK is externalized and not minified by us, preserving
      // class identity across the test fake and this import.
      const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js');
      if (err instanceof UnauthorizedError) return 'pending';
    }
    throw err;
  }
}

/**
 * Build a transport + `Client`, then connect. `override` is the `@internal` test seam.
 * `authorizationCode` enables the resume path (exchange-then-connect on a single fresh transport).
 *
 * The connect is bounded by `requestTimeoutMs` (a hung server during the initialize handshake no
 * longer hangs `createMcpTools` forever). If connect (or the resume `finishAuth` exchange) throws,
 * the freshly-built client/transport are closed so nothing leaks — `Client.close()` closes the
 * underlying transport.
 */
async function connectMcpServer(
  config: McpServerConfig,
  override?: Transport,
  authorizationCode?: string,
): Promise<ConnectedServer> {
  const transport = await buildTransport(config, override);
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const { signal, cleanup } = withTimeout(
    undefined,
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  let authState: McpAuthState;
  try {
    authState = await connectClient(client, transport, config, authorizationCode, signal);
  } catch (err) {
    await client.close().catch(() => {
      /* ignore — closing must never throw during cleanup */
    });
    throw err;
  } finally {
    cleanup();
  }

  const close = async (): Promise<void> => {
    try {
      await transport.terminateSession?.();
    } catch {
      // terminateSession is best-effort; ignore failures (server may already be gone).
    }
    await client.close().catch(() => {
      /* ignore — closing must never throw during cleanup */
    });
  };

  return { client, transport, authState, close };
}

/**
 * Paginate `client.listTools`, following `nextCursor`, into a flat `McpTool[]`. Bounded by
 * `config.requestTimeoutMs` — the docs promise the timeout covers `listTools` as well as `callTool`.
 */
async function listAllTools(client: Client, config: McpServerConfig): Promise<McpTool[]> {
  const { signal, cleanup } = withTimeout(
    undefined,
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  try {
    const all: McpTool[] = [];
    let cursor: string | undefined;
    for (;;) {
      const result = await client.listTools(
        cursor ? { cursor } : undefined,
        signal ? { signal } : undefined,
      );
      all.push(...(result.tools as McpTool[]));
      cursor = (result as { nextCursor?: string }).nextCursor;
      if (!cursor) break;
    }
    return all;
  } finally {
    cleanup();
  }
}

/** List a server's tools and adapt them into `FunctionDefinition`s using `config`'s policy. */
async function listAndAdapt(
  client: Client,
  config: McpServerConfig,
): Promise<FunctionDefinition[]> {
  const tools = await listAllTools(client, config);
  const policy = policyFromConfig(config);
  return adaptMcpTools(wrapClient(client), tools, policy);
}

/** Build the preflight error message for a server whose write/destructive tools lack confirmation. */
function preflightMessage(config: McpServerConfig, tools: FunctionDefinition[]): string {
  return (
    `[Forgewisp] Cannot register MCP server "${config.name}": it exposes ` +
    `${tools.filter((t) => t.riskTier !== 'read').length} write/destructive tool(s) ` +
    `but \`hasConfirmation\` is not set. Configure the agent's \`onConfirmRequired\` and pass ` +
    `\`hasConfirmation: true\` to \`registerMcpServer\`, or map those tools to \`read\` via ` +
    `\`tierOverrides\`.`
  );
}

/**
 * Run the `hasConfirmation` preflight and register `tools` on the agent, rolling back on a partial
 * registration failure (core's own registration-time invariant is the backstop). Returns the
 * registered tool names. Throws (registering nothing) when the preflight fails.
 */
function preflightAndRegister(
  agent: AgentLike,
  config: McpServerConfig,
  tools: FunctionDefinition[],
): string[] {
  const names = tools.map((t) => t.name);
  const needsConfirmation = tools.some((t) => t.riskTier !== 'read');
  if (needsConfirmation && !config.hasConfirmation) {
    throw new Error(preflightMessage(config, tools));
  }
  try {
    for (const def of tools) agent.registerFunction(def);
  } catch (err) {
    for (const name of names) agent.deregisterFunction(name);
    throw err;
  }
  return names;
}

// ─── Public wiring ───────────────────────────────────────────────────────────

/** Shape returned by `createMcpTools`: the adapted tools, a closer, and (for OAuth) the auth flow. */
export interface McpToolsResult {
  /** The adapted `FunctionDefinition`s. Empty while `authState` is `'pending'`; mutated in place by
   *  `finishAuth` once auth completes, so the caller's reference stays valid. */
  tools: FunctionDefinition[];
  /** Authorization state. `'pending'` means the server requires OAuth and `finishAuth` (or a
   *  resume via `options.authorizationCode`) is needed before tools are available. */
  authState: McpAuthState;
  /** Disconnects the underlying client. Idempotent. */
  close: () => Promise<void>;
  /** Completes the OAuth redirect-back. See `McpServerHandle.finishAuth`. */
  finishAuth: (authorizationCode: string) => Promise<void>;
}

/**
 * Connect to an MCP server, list its tools, and adapt them into `FunctionDefinition`s without
 * touching any agent. Useful for custom registration or `ToolSet` composition. The returned
 * `close()` disconnects the underlying client.
 *
 * OAuth: when `config.authProvider` is set and the server requires auth, the first connect returns
 * `authState: 'pending'` with an empty `tools` array (the SDK already redirected the user agent).
 * Call `finishAuth(code)` after the redirect-back to exchange the code and populate `tools`, or pass
 * `options.authorizationCode` to resume in one shot after a page reload.
 *
 * @internal `options.transport` is a test seam to inject a non-HTTP transport; not part of the
 *   stable public contract.
 */
export async function createMcpTools(
  config: McpServerConfig,
  options?: McpConnectOptions,
): Promise<McpToolsResult> {
  const transportSeam = options?.transport;
  const resolveTransport = (): Transport | Promise<Transport> | undefined =>
    typeof transportSeam === 'function' ? transportSeam() : transportSeam;

  let connected = await connectMcpServer(
    config,
    await resolveTransport(),
    options?.authorizationCode,
  );

  const tools: FunctionDefinition[] = [];
  let authState: McpAuthState = connected.authState;
  if (authState === 'authorized') {
    try {
      tools.push(...(await listAndAdapt(connected.client, config)));
    } catch (err) {
      // Connect succeeded but listing/adapting threw — close the open client/transport so the
      // session doesn't leak (the caller never receives a handle to close it).
      await connected.close().catch(() => {
        /* ignore — closing must never throw during cleanup */
      });
      throw err;
    }
  }
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await connected.close().catch(() => {
      /* closing must never throw during cleanup */
    });
  };

  const finishAuth = async (authorizationCode: string): Promise<void> => {
    if (closed) throw new Error('[Forgewisp MCP] finishAuth called after close.');
    if (authState === 'authorized') return; // idempotent — already authorized (e.g. double call)
    if (!config.authProvider) {
      throw new Error('[Forgewisp MCP] finishAuth requires an `authProvider` in the config.');
    }
    // Exchange the code on the spent transport (saves tokens into the provider), disconnect it, then
    // build a fresh transport whose connect reads the saved token. See the file header: a spent
    // transport cannot be re-`connect`ed, so a fresh one is required on resume. The transport seam is
    // re-resolved so a factory seam yields a fresh transport (a single-instance seam is only used on
    // the initial connect and never reaches here in practice, since `finishAuth` requires
    // `authProvider` and the non-OAuth tests never call it).
    await connected.transport.finishAuth?.(authorizationCode);
    await connected.close().catch(() => {
      /* the spent client/transport may already be closed by the failed connect */
    });
    const resumed = await connectMcpServer(config, await resolveTransport());
    try {
      if (resumed.authState !== 'authorized') {
        throw new Error(
          '[Forgewisp MCP] finishAuth did not result in an authorized connection ' +
            '(the authorization code may be invalid or expired).',
        );
      }
      const newTools = await listAndAdapt(resumed.client, config);
      // `close()` may have run during the multi-second exchange + reconnect above (the user hit
      // Disconnect mid-authorization). If so, drop the fresh connection and bail without adopting it
      // — otherwise `connected = resumed` would revive a server the user closed, and `close()` would
      // be a no-op (closed=true) so the fresh session could never be torn down. Throwing lets the
      // caller's catch path finish the cleanup it already started.
      if (closed) {
        await resumed.close().catch(() => {
          /* ignore */
        });
        throw new Error(
          '[Forgewisp MCP] finishAuth aborted — close() was called during authorization.',
        );
      }
      tools.length = 0;
      tools.push(...newTools);
      authState = 'authorized';
      connected = resumed;
    } catch (err) {
      // listAndAdapt threw, the post-auth state wasn't authorized, or close() raced — either way the
      // fresh `resumed` client/transport must not leak (the caller's close() still points at the old,
      // already-closed `connected`).
      await resumed.close().catch(() => {
        /* ignore */
      });
      throw err;
    }
  };

  return {
    tools,
    get authState(): McpAuthState {
      return authState;
    },
    close,
    finishAuth,
  };
}

/**
 * Connect to an MCP server and register all of its (adapted) tools on the given agent. Returns an
 * `McpServerHandle` whose `close()` deregisters every tool and disconnects.
 *
 * Confirmation preflight: before registering anything, if any adapted tool resolves to
 * `write`/`destructive` and `config.hasConfirmation` is not `true`, the client is closed and a
 * clear error is thrown — so a tier mismatch never leaves a partially-registered server. Core's
 * own registration-time invariant still fires as a backstop inside `agent.registerFunction`.
 *
 * OAuth: when the first connect returns `authState: 'pending'`, no tools are registered yet and the
 * preflight is deferred until `handle.finishAuth(code)` lists the tools. If the post-auth preflight
 * fails, `finishAuth` deregisters anything registered, disconnects, and throws the same error.
 *
 * @internal `options.transport` is a test seam to inject a non-HTTP transport.
 */
export async function registerMcpServer(
  agent: AgentLike,
  config: McpServerConfig,
  options?: McpConnectOptions,
): Promise<McpServerHandle> {
  const created = await createMcpTools(config, options);
  const { tools, close: disconnect } = created;

  const toolNames: string[] = [];
  let closed = false;

  // Authorized path: preflight + register now.
  if (created.authState === 'authorized') {
    try {
      toolNames.push(...preflightAndRegister(agent, config, tools));
    } catch (err) {
      closed = true;
      await disconnect().catch(() => {
        /* ignore */
      });
      throw err;
    }
  }
  // Pending path: nothing registered; preflight + register happen in finishAuth.

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const name of toolNames) agent.deregisterFunction(name);
    toolNames.length = 0;
    await disconnect().catch(() => {
      /* ignore */
    });
  };

  const finishAuth = async (authorizationCode: string): Promise<void> => {
    if (closed) throw new Error('[Forgewisp MCP] finishAuth called after close.');
    if (created.authState === 'authorized') return; // idempotent
    try {
      await created.finishAuth(authorizationCode); // exchange + reconnect + populate created.tools
      const names = preflightAndRegister(agent, config, created.tools);
      toolNames.length = 0;
      toolNames.push(...names);
    } catch (err) {
      closed = true;
      toolNames.length = 0;
      await disconnect().catch(() => {
        /* ignore */
      });
      throw err;
    }
  };

  return {
    toolNames,
    get authState(): McpAuthState {
      return created.authState;
    },
    finishAuth,
    close,
  };
}
