// Public types for @forgewisp/mcp.
//
// Re-export the core types this package is built around so consumers can import everything
// from one place. Type-only re-exports don't pull @forgewisp/core into the runtime bundle
// (tsup externalizes declared deps, and there are no runtime value imports of core here —
// the adapter builds plain `FunctionDefinition` literals and hands them to the caller's
// agent, it never instantiates any core class).
export type {
  FunctionDefinition,
  RiskTier,
  JSONSchema,
  JSONSchemaProperty,
  ToolContext,
} from '@forgewisp/core';

// OAuth shapes from the MCP SDK. `OAuthClientProvider` (the interface consumers implement) lives
// in `client/auth.js`; the supporting value types live in `shared/auth.js` (the client module imports
// but does not re-export them). Type-only re-exports don't add to the runtime bundle (tsup
// externalizes the SDK), and `client/auth.js` is only *evaluated* when an `authProvider` is used
// (the transport module is dynamically imported on the OAuth path in `mcp.ts`). Re-exporting them
// here lets consumers import everything from `@forgewisp/mcp` instead of reaching into the SDK.
export type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
export type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type { FunctionDefinition, RiskTier } from '@forgewisp/core';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Structural view of a Forgewisp agent: the two methods the MCP integration needs. The real
 * `ForgewispAgent` (from `createAgent`) satisfies this structurally, so consumers pass their
 * agent instance directly: `await registerMcpServer(agent, { ... })`. Declaring a structural
 * subset (rather than importing the not-exported `ForgewispAgent` class) keeps this package
 * decoupled from core's internals — same technique `apps/bundled-demo` uses for its `ToolMeta`.
 */
export interface AgentLike {
  /** Registers a tool. Throws at registration time for `write`/`destructive` tools when the
   *  agent's `onConfirmRequired` is unset (core enforces this — see `packages/core/src/agent.ts`). */
  registerFunction(def: FunctionDefinition): void;
  /** Deregisters a tool by name. No-op if unknown. */
  deregisterFunction(name: string): void;
}

/**
 * Configuration for connecting an MCP server and adapting its tools into Forgewisp
 * `FunctionDefinition`s.
 */
export interface McpServerConfig {
  /**
   * Logical server name. Used as the default `toolNamePrefix` and as the audit/UI attribution
   * suffix on each tool's description. Also identifies the server in error messages.
   */
  name: string;
  /** Streamable HTTP endpoint URL of the MCP server. */
  url: string;
  /**
   * Optional bearer token sent to the MCP endpoint as `Authorization: Bearer <apiKey>`. The
   * header is omitted entirely when unset, so no-auth/proxy endpoints work — mirrors core's
   * `HttpClient` (which only sends `Authorization` when an `apiKey` is configured). Mutually
   * exclusive with `authProvider`; when both are set, `authProvider` wins and `apiKey` is ignored.
   * Use this when you already hold an access token; use `authProvider` when the server requires a
   * full OAuth flow to *obtain* one.
   */
  apiKey?: string;
  /**
   * OAuth client provider. When set, takes precedence over `apiKey` and drives the full OAuth 2.1
   * authorization-code + PKCE flow via the SDK: RFC 9728 protected-resource discovery, RFC 8414
   * authorization-server metadata discovery, dynamic client registration (RFC 7591) when the
   * server supports it, token exchange, and refresh. The consumer owns browser-redirect plumbing
   * and token storage by implementing `OAuthClientProvider`.
   *
   * On the first connect, if the server requires auth and no usable token exists, the SDK calls
   * `authProvider.redirectToAuthorization(url)` and the connect returns `authState: 'pending'`
   * with an empty `tools` array (instead of throwing). The consumer completes the redirect-back and
   * calls `finishAuth(code)` on the handle (or, after a page reload, calls
   * `createMcpTools`/`registerMcpServer` again with `options.authorizationCode`). See `mcp.ts` for
   * why a fresh transport is built on resume (the SDK cannot re-`connect` a spent transport).
   */
  authProvider?: OAuthClientProvider;
  /** Per-call timeout for MCP `listTools`/`callTool` requests, in milliseconds. Default 60_000. */
  requestTimeoutMs?: number;
  /** Prefix for the registered (prefixed) tool names. Default: `config.name`. */
  toolNamePrefix?: string;
  /** Default risk tier for tools not listed in `tierOverrides`. Default: `'read'`. */
  defaultTier?: RiskTier;
  /** Map of original MCP tool name → risk tier (overrides `defaultTier` for that tool). */
  tierOverrides?: Record<string, RiskTier>;
  /** Allowlist of original MCP tool names to register; all others are skipped. */
  onlyTools?: string[];
  /** Blocklist of original MCP tool names to skip. */
  excludeTools?: string[];
  /**
   * Whether the agent has `onConfirmRequired` configured. Required to be `true` when any
   * resolved tool tier is `write` or `destructive`; `registerMcpServer` throws a clear error
   * up front (before registering anything) otherwise — so a tier mismatch never leaves a
   * partially-registered server. Core's own registration-time invariant still fires as a
   * backstop inside `agent.registerFunction`.
   */
  hasConfirmation?: boolean;
}

/** Handle returned by `registerMcpServer` for managing a server's lifecycle. */
export interface McpServerHandle {
  /** The prefixed tool names that were registered on the agent. Empty while `authState` is
   *  `'pending'` (tools are not listed until auth completes). */
  toolNames: string[];
  /** Authorization state. `'pending'` means the server requires OAuth and the consumer must complete
   *  the redirect-back via `finishAuth` (or resume with `options.authorizationCode`). */
  authState: McpAuthState;
  /**
   * Complete the OAuth redirect-back: exchange `authorizationCode` for tokens (via the provider),
   * build a fresh transport, reconnect, list the server's tools, run the `hasConfirmation`
   * preflight, and register the tools on the agent. Mutates `toolNames`/`authState` in place.
   *
   * Rejects if already authorized or closed, or if the post-auth preflight fails (in which case
   * nothing remains registered). Idempotent guard: a second `finishAuth` is a no-op.
   */
  finishAuth(authorizationCode: string): Promise<void>;
  /** Deregisters all of this server's tools from the agent and disconnects from the MCP server. */
  close(): Promise<void>;
}

/** Authorization state of a connected MCP server. */
export type McpAuthState = 'authorized' | 'pending';

/**
 * Options for `createMcpTools` / `registerMcpServer`.
 */
export interface McpConnectOptions {
  /**
   * Resume path: an authorization code obtained from the redirect-back after a page reload (or a
   * blocked-popup same-tab navigation). When set alongside `config.authProvider`, the code is
   * exchanged for tokens on a fresh transport *before* connecting, so the (re)connect reads the
   * saved token and returns `authState: 'authorized'` directly — skipping the pending state.
   * Ignored when `authProvider` is not set.
   */
  authorizationCode?: string;
  /**
   * @internal Test seam to inject a non-HTTP transport (e.g. `InMemoryTransport` or an OAuth-gated
   *   fake), so tests never dynamic-import `StreamableHTTPClientTransport`. May be a single
   *   `Transport` (used once for the initial connect — fine for non-OAuth tests, where `finishAuth`
   *   is never called) or a factory `() => Transport | Promise<Transport>` invoked each time a
   *   transport is needed (initial connect AND each `finishAuth` reconnect), which is how OAuth
   *   tests supply a fresh gated transport that shares one in-memory pipe. Not part of the stable
   *   public contract.
   */
  transport?: Transport | (() => Transport | Promise<Transport>);
}

// ─── Internal MCP-shape types (not exported from the package barrel) ─────────
// Minimal structural views of the MCP SDK shapes the adapter depends on. Keeping these local
// (rather than importing the SDK's `Tool`/`CallToolResult` types) lets the pure `adaptMcpTools`
// unit tests build plain objects without dragging the SDK into the test setup, and decouples
// the adapter from SDK version drift in those shapes.

/** Minimal view of an MCP `Tool` as returned by `client.listTools()`. */
export interface McpTool {
  name: string;
  description?: string;
  /** The tool's input schema (full draft-07 JSON Schema). Passed through to the LLM. */
  inputSchema: Record<string, unknown> & { type: 'object' };
  /** MCP tool annotations; `readOnlyHint`/`destructiveHint` are informational only — tiers come
   *  from `McpServerConfig`, not these hints (MCP has no formal risk tier). */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

/** Minimal view of a single MCP content item (text/image/audio/resource/…). */
export interface McpContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Minimal view of `client.callTool()`'s result. */
export interface McpCallToolResult {
  content: McpContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * Minimal structural view of an MCP `Client` the adapter calls. The SDK's `Client` satisfies
 * this. The three-argument `callTool` mirrors the SDK signature `(params, resultSchema?, options?)`
 * — the adapter passes `undefined` for `resultSchema` and the abort-bearing options third.
 */
export interface McpClient {
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<McpCallToolResult>;
}
