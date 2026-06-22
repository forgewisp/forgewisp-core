// ─── JSON Schema ────────────────────────────────────────────────────────────

export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

// ─── Risk Tiers ─────────────────────────────────────────────────────────────

/**
 * read        — executes immediately, no confirmation needed
 * write       — calls onConfirmRequired before executing
 * destructive — calls onConfirmRequired before executing; always render
 *               confirmation UI from validated args, never LLM-generated text
 */
export type RiskTier = 'read' | 'write' | 'destructive';

// ─── Function Registration ───────────────────────────────────────────────────

export interface FunctionDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JSONSchema;
  riskTier: RiskTier;
  handler: (args: TArgs) => unknown;
}

// ─── Pending Call ────────────────────────────────────────────────────────────

export interface PendingCall {
  functionName: string;
  riskTier: RiskTier;
  /** Always validated, schema-conformant values. Never raw LLM output. */
  args: Record<string, unknown>;
  description: string;
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

export type AuditEventType =
  | 'function_requested'
  | 'validation_passed'
  | 'validation_failed'
  | 'confirmation_requested'
  | 'confirmation_accepted'
  | 'confirmation_rejected'
  | 'function_executed'
  | 'function_errored'
  | 'audit_callback_errored'
  | 'max_tool_rounds_reached'
  | 'stream_malformed';

export interface AuditEvent {
  id: string;
  timestamp: string;
  type: AuditEventType;
  functionName: string;
  riskTier?: RiskTier;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

// ─── Streaming ───────────────────────────────────────────────────────────────

/**
 * Reasoning mode declared by the developer in ForgewispConfig.
 *
 * none       — no reasoning separation; onReasoningChunk is never called
 * extended   — OpenAI o1/o3 reasoning_tokens count, surfaced as an annotation.
 * tag-based  — model wraps reasoning in a developer-specified tag, e.g.
 *              <thinking>...</thinking>. Forgewisp parses the stream in real
 *              time and routes inner content to onReasoningChunk and outer
 *              content to onTextChunk.
 * native     — the server streams reasoning in a separate delta field
 *              (`reasoning` for Ollama, `reasoning_content` for vLLM/DashScope).
 *              Forgewisp routes each reasoning delta straight to onReasoningChunk
 *              without scanning the text content.
 */
export type ReasoningMode =
  | { mode: 'none' }
  | { mode: 'extended' }
  | { mode: 'tag-based'; tag: string }
  | { mode: 'native' };

export interface StreamingConfig {
  reasoning?: ReasoningMode;
  /** Called with each text delta of the final response. */
  onTextChunk?: (chunk: string) => void;
  /** Called with each reasoning delta (both extended and tag-based modes). */
  onReasoningChunk?: (chunk: string) => void;
  /** Called when an SSE `data:` line cannot be parsed as JSON. The stream continues. */
  onMalformedChunk?: (info: { raw: string; error: string }) => void;
}

// ─── Chat History ────────────────────────────────────────────────────────────

/**
 * A single prior chat turn, passed to `agent.run` as `history`. Only user and
 * assistant text turns are supported — internal tool/tool_calls plumbing is
 * not exposed, so callers cannot construct transcripts the API would reject.
 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Agent Config ────────────────────────────────────────────────────────────

export interface AuditConfig {
  /** Max events retained in memory. Oldest dropped when exceeded. Default 1000. */
  maxEvents?: number;
  /** Called after every audit event (post-redaction). */
  onEvent?: (event: AuditEvent) => void;
  /**
   * Optional redactor applied to each event before it is stored and before
   * onEvent fires. Use to strip secrets (API keys, credentials) from
   * `args`/`result`/`error`. Must return a valid AuditEvent.
   */
  redact?: (event: AuditEvent) => AuditEvent;
}

export interface ForgewispConfig {
  /** Any OpenAI-compatible endpoint URL. */
  llmEndpoint: string;
  /** API key. Omit if the endpoint is proxied. */
  apiKey?: string;
  /** Model identifier string (e.g. "gpt-4o"). */
  model: string;
  /** Optional system prompt prepended to every conversation. */
  systemPrompt?: string;
  /**
   * Called for write and destructive risk tiers before execution.
   * Resolve true to proceed, false to abort.
   *
   * Required when any registered tool has `riskTier !== 'read'`; registerFunction
   * throws at registration time if a write/destructive tool is added without one.
   */
  onConfirmRequired?: (call: PendingCall) => Promise<boolean>;
  /**
   * Called after every audit event.
   * @deprecated Use `audit.onEvent` instead. Copied into `audit.onEvent` when
   *   `audit` is omitted, for backwards compatibility during migration.
   */
  onAuditEvent?: (event: AuditEvent) => void;
  /** Audit log configuration: event cap, callback, redactor. */
  audit?: AuditConfig;
  /** Streaming and reasoning configuration. Omit to disable streaming. */
  streaming?: StreamingConfig;
  /** Per-request timeout in milliseconds. Defaults to 60000. Set to 0 to disable. */
  requestTimeoutMs?: number;
  /** Max tool-call rounds before the loop truncates. Defaults to 10. */
  maxToolRounds?: number;
}

// ─── Agent Result ────────────────────────────────────────────────────────────

export interface AgentReasoning {
  mode: ReasoningMode['mode'];
  text: string;
  /** Present when mode is 'extended' and the API returned reasoning_tokens. */
  tokens?: number;
}

export interface AgentResult {
  response: string;
  /** Structured reasoning captured during the run, if any. */
  reasoning?: AgentReasoning;
  /** True when the tool-call loop hit the max-rounds cap without a final response. */
  truncated: boolean;
  toolCallsExecuted: Array<{
    functionName: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
  toolCallsAborted: Array<{
    functionName: string;
    reason:
      | 'validation_failed'
      | 'confirmation_rejected'
      | 'handler_errored'
      | 'no_confirmation_handler';
    error?: string;
  }>;
}
