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
} from './types.js';
