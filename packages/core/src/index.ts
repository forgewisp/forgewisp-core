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

export type {
  ForgewispConfig,
  AuditConfig,
  ChatMessage,
  FunctionDefinition,
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
} from './types.js';
