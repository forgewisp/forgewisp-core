import { AuditLog } from './audit.js';
import { FunctionRegistry } from './registry.js';
import { validateArgs } from './validator.js';
import {
  AgentResult,
  AuditEvent,
  AuditEventType,
  FunctionDefinition,
  PendingCall,
  ForgewispConfig,
} from './types.js';
import type { LLMToolCall } from './wire.js';

type AbortReason = AgentResult['toolCallsAborted'][number]['reason'];

interface ExecuteResult {
  toolCallId: string;
  functionName: string;
  success: boolean;
  result?: unknown;
  error?: string;
  abortReason?: AbortReason;
}

interface BufferedEvent {
  type: AuditEventType;
  functionName: string;
  extras: Partial<AuditEvent>;
}

interface CallOutcome {
  executed?: AgentResult['toolCallsExecuted'][number];
  aborted?: { functionName: string; reason: AbortReason; error?: string };
  toolResult: ExecuteResult;
  events: BufferedEvent[];
}

interface ReadyCall {
  call: LLMToolCall;
  def: FunctionDefinition;
  args: Record<string, unknown>;
}

export async function executeToolCalls(
  toolCalls: LLMToolCall[],
  registry: FunctionRegistry,
  audit: AuditLog,
  config: ForgewispConfig,
): Promise<{
  toolResults: ExecuteResult[];
  executed: AgentResult['toolCallsExecuted'];
  aborted: AgentResult['toolCallsAborted'];
}> {
  const toolResults: ExecuteResult[] = [];
  const executed: AgentResult['toolCallsExecuted'] = [];
  const aborted: AgentResult['toolCallsAborted'] = [];

  const abort = (
    call: LLMToolCall,
    name: string,
    reason: AbortReason,
    auditType: AuditEventType,
    extras: Partial<AuditEvent> = {},
  ): void => {
    audit.record(auditType, name, extras);
    const error = extras.error;
    aborted.push(error ? { functionName: name, reason, error } : { functionName: name, reason });
    toolResults.push({
      toolCallId: call.id,
      functionName: name,
      success: false,
      error,
      abortReason: reason,
    });
  };

  // ── Pre-pass: synchronous lookup / parse / validate. Audit events emitted
  // here (function_requested, validation_passed, validation_failed) are
  // recorded in input order before any async work begins. Calls that pass
  // validation are queued for concurrent execution.
  const ready: ReadyCall[] = [];
  for (const call of toolCalls) {
    const { name, arguments: rawArgs } = call.function;

    const def: FunctionDefinition | undefined = registry.get(name);
    if (!def) {
      abort(call, name, 'validation_failed', 'validation_failed', {
        error: `No registered function named "${name}"`,
      });
      continue;
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      abort(call, name, 'validation_failed', 'validation_failed', {
        error: `Failed to parse arguments JSON: ${rawArgs}`,
      });
      continue;
    }

    audit.record('function_requested', name, { riskTier: def.riskTier, args });

    const validation = validateArgs(args, def.parameters);
    if (!validation.valid) {
      abort(call, name, 'validation_failed', 'validation_failed', {
        args,
        error: `Validation failed: ${validation.errors.join('; ')}`,
      });
      continue;
    }

    audit.record('validation_passed', name, { riskTier: def.riskTier, args });
    ready.push({ call, def, args });
  }

  // ── Concurrent pass: confirmation + handler execution for all validated
  // calls run in parallel via Promise.allSettled. Each wrapper buffers its
  // audit events; the post-await flush emits them in input order so the audit
  // log preserves call order even when later calls finish before earlier ones.
  const outcomes = await Promise.allSettled(ready.map((rc) => runCall(rc, config)));

  for (const settled of outcomes) {
    if (settled.status !== 'fulfilled') continue;
    const outcome = settled.value;
    for (const ev of outcome.events) {
      audit.record(ev.type, ev.functionName, ev.extras);
    }
    if (outcome.executed) executed.push(outcome.executed);
    if (outcome.aborted) aborted.push(outcome.aborted);
    toolResults.push(outcome.toolResult);
  }

  return { toolResults, executed, aborted };
}

async function runCall(rc: ReadyCall, config: ForgewispConfig): Promise<CallOutcome> {
  const { call, def, args } = rc;
  const name = def.name;
  const events: BufferedEvent[] = [];

  if (def.riskTier !== 'read') {
    const pendingCall: PendingCall = {
      functionName: name,
      riskTier: def.riskTier,
      args,
      description: def.description,
    };

    events.push({
      type: 'confirmation_requested',
      functionName: name,
      extras: { riskTier: def.riskTier, args },
    });

    if (!config.onConfirmRequired) {
      const error = `No onConfirmRequired handler configured for "${name}" (riskTier: ${def.riskTier}).`;
      events.push({
        type: 'confirmation_rejected',
        functionName: name,
        extras: { riskTier: def.riskTier, args, error },
      });
      return {
        aborted: { functionName: name, reason: 'no_confirmation_handler', error },
        toolResult: {
          toolCallId: call.id,
          functionName: name,
          success: false,
          error,
          abortReason: 'no_confirmation_handler',
        },
        events,
      };
    }

    let confirmed: boolean;
    try {
      confirmed = await config.onConfirmRequired(pendingCall);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      events.push({
        type: 'function_errored',
        functionName: name,
        extras: { riskTier: def.riskTier, args, error },
      });
      return {
        aborted: { functionName: name, reason: 'handler_errored', error },
        toolResult: {
          toolCallId: call.id,
          functionName: name,
          success: false,
          error,
          abortReason: 'handler_errored',
        },
        events,
      };
    }

    if (!confirmed) {
      events.push({
        type: 'confirmation_rejected',
        functionName: name,
        extras: { riskTier: def.riskTier, args },
      });
      return {
        aborted: { functionName: name, reason: 'confirmation_rejected' },
        toolResult: {
          toolCallId: call.id,
          functionName: name,
          success: false,
          abortReason: 'confirmation_rejected',
        },
        events,
      };
    }

    events.push({
      type: 'confirmation_accepted',
      functionName: name,
      extras: { riskTier: def.riskTier, args },
    });
  }

  try {
    const result = await Promise.resolve(def.handler(args));
    events.push({
      type: 'function_executed',
      functionName: name,
      extras: { riskTier: def.riskTier, args, result },
    });
    return {
      executed: { functionName: name, args, result },
      toolResult: { toolCallId: call.id, functionName: name, success: true, result },
      events,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    events.push({
      type: 'function_errored',
      functionName: name,
      extras: { riskTier: def.riskTier, args, error },
    });
    return {
      aborted: { functionName: name, reason: 'handler_errored', error },
      toolResult: {
        toolCallId: call.id,
        functionName: name,
        success: false,
        error,
        abortReason: 'handler_errored',
      },
      events,
    };
  }
}
