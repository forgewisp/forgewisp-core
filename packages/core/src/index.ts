import { ForgewispAgent } from './agent.js';
import type { ForgewispConfig } from './types.js';

/**
 * Create a Forgewisp agent. The agent class itself is not exported — use this
 * factory and the typed methods on the returned instance. To name the agent
 * type, use `ReturnType<typeof createAgent>`.
 */
export function createAgent(config: ForgewispConfig): ForgewispAgent {
  return new ForgewispAgent(config);
}

export { defineToolSet } from './tool-set.js';

// Structured HTTP error thrown by the internal HttpClient after exhausting its
// retry budget (or immediately for a non-retryable status). Exported so callers
// can branch on `isHttpError(err)` / `err.isRetryable` (e.g. a higher-level
// retry layer). See `http.ts` for the retry/backoff contract.
export { HttpError, isHttpError } from './http.js';

// Subagent orchestration factory. Builds + runs a fresh subagent per `spawnSubagent` call
// from a declarative config (no consumer-written spawn closure). Lives in core because it
// needs `createAgent` at runtime (a same-package call). See `subagent-tool.ts` for the
// risk-tier rationale, recursion guard, and abort-signal notes.
export { createSubagentTool } from './subagent-tool.js';
export type {
  SubagentToolConfig,
  SpawnSubagentArgs,
  SpawnSubagentResult,
} from './subagent-tool.js';

export type {
  ForgewispConfig,
  AuditConfig,
  ChatMessage,
  FunctionDefinition,
  ToolSet,
  RiskTier,
  JSONSchema,
  JSONSchemaProperty,
  PendingCall,
  AuditEvent,
  AuditEventType,
  AgentResult,
  AgentReasoning,
  StreamingConfig,
  ReasoningMode,
  ToolContext,
  HttpConfig,
} from './types.js';
