// @forgewisp/mcp — Model Context Protocol client support for Forgewisp agents.
//
// Connects an MCP server (Streamable HTTP) and adapts its tools into Forgewisp
// `FunctionDefinition`s registered through the agent's existing `registerFunction` path. Core
// is not modified and is a types-only/peer dependency here; the only runtime dependency pulled
// in by this package is `@modelcontextprotocol/sdk`.
//
// Re-export the core types consumers need alongside the MCP API so everything imports from one
// place. Type-only re-exports don't affect the runtime bundle.
export type {
  FunctionDefinition,
  RiskTier,
  JSONSchema,
  JSONSchemaProperty,
  ToolContext,
} from '@forgewisp/core';

// OAuth shapes from the MCP SDK, re-exported so consumers import everything from one place.
// `OAuthClientProvider` lives in `client/auth.js`; the supporting value types live in
// `shared/auth.js`. Type-only re-exports don't add to the runtime bundle (tsup externalizes the
// SDK, and `client/auth.js` is only evaluated on the OAuth path via a dynamic import in `mcp.ts`).
export type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
export type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export type {
  AgentLike,
  McpServerConfig,
  McpServerHandle,
  McpAuthState,
  McpConnectOptions,
} from './types.js';
export { registerMcpServer, createMcpTools } from './mcp.js';
export type { McpToolsResult } from './mcp.js';
