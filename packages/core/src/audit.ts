import { AuditEvent, AuditEventType } from './types.js';

const DEFAULT_MAX_EVENTS = 1000;

const REDACT_ERROR_MESSAGE = 'redact callback threw an error';
const AUDIT_CALLBACK_NON_COERCIBLE_MESSAGE = 'audit callback threw a non-coercible error';

export class AuditLog {
  private events: AuditEvent[] = [];
  private onEvent?: (event: AuditEvent) => void;
  private redact?: (event: AuditEvent) => AuditEvent;
  private maxEvents: number;

  constructor(
    onEvent?: (event: AuditEvent) => void,
    maxEvents: number = DEFAULT_MAX_EVENTS,
    redact?: (event: AuditEvent) => AuditEvent,
  ) {
    this.onEvent = onEvent;
    this.maxEvents = maxEvents > 0 ? maxEvents : Number.POSITIVE_INFINITY;
    this.redact = redact;
  }

  record(
    type: AuditEventType,
    functionName: string,
    extras: Partial<Omit<AuditEvent, 'id' | 'timestamp' | 'type' | 'functionName'>> = {},
  ): AuditEvent {
    const raw: AuditEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      functionName,
      ...extras,
    };
    let event: AuditEvent;
    if (this.redact) {
      try {
        const redacted: unknown = this.redact(raw);
        if (!this.isValidAuditEvent(redacted)) {
          // A redactor that returns null/undefined/a partial object has not
          // produced a safe event. The unredacted `raw` event may carry
          // secrets, so it must never be stored — treat this exactly like a
          // throw: drop the offending event and record redact_errored.
          return this.failRedact(
            functionName,
            new Error('redact callback returned a non-AuditEvent value'),
          );
        }
        event = redacted;
      } catch (err) {
        // A throwing redactor must never break the tool-call loop, and the
        // unredacted event must never be stored — it may carry secrets the
        // redactor was supposed to scrub. Drop it and record a synthetic
        // redact_errored event. redact threw, not onEvent, so still deliver
        // the synthetic event to onEvent for live observability (a consumer
        // whose only hook is onEvent must see that redaction is failing).
        return this.failRedact(functionName, err);
      }
    } else {
      event = raw;
    }
    this.pushBounded(event);
    try {
      this.onEvent?.(event);
    } catch (err) {
      // A throwing audit callback must never break the tool-call loop. Record
      // a synthetic event directly. Do NOT re-invoke the callback — it just
      // threw on this event and would throw again.
      this.pushBounded(this.buildErrorEvent('audit_callback_errored', functionName, err));
    }
    return event;
  }

  /**
   * Drop the unredacted event and record a `redact_errored` synthetic event,
   * then deliver that synthetic event to `onEvent` (guarded, so a throwing
   * `onEvent` degrades to `audit_callback_errored` rather than escaping).
   */
  private failRedact(functionName: string, err: unknown): AuditEvent {
    const errored = this.buildErrorEvent('redact_errored', functionName, err);
    this.pushBounded(errored);
    try {
      this.onEvent?.(errored);
    } catch (err2) {
      this.pushBounded(this.buildErrorEvent('audit_callback_errored', functionName, err2));
    }
    return errored;
  }

  /**
   * Build a synthetic `*_errored` event with an error message that is safe to
   * store. Centralizes the two synthetic-event paths so their shape cannot
   * drift, and so the coercion below is guarded exactly once.
   */
  private buildErrorEvent(
    type: 'redact_errored' | 'audit_callback_errored',
    functionName: string,
    err: unknown,
  ): AuditEvent {
    return {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      functionName,
      error: this.coerceErrorMessage(type, err),
    };
  }

  /**
   * Coerce a thrown value to a storable message without itself throwing.
   *
   * `redact_errored` is OPAQUE by design: the redact callback runs on the
   * UNREDACTED event, so its thrown message may echo the very secret it was
   * scrubbing (e.g. a `new Error('cannot scrub token: ' + token)` or a
   * `JSON.parse` SyntaxError quoting the offending substring). Storing that
   * verbatim would leak the secret the redactor existed to keep out of the
   * log — the opposite of the hardening this path provides.
   *
   * `audit_callback_errored` runs on an already-redacted event, so its
   * message is safe to keep for debuggability. The coercion is still guarded:
   * a thrown value with a throwing `toString`/`Symbol.toPrimitive`, or an
   * Error subclass with a throwing `message` getter, would otherwise escape
   * `record()` and break the tool-call loop.
   */
  private coerceErrorMessage(
    type: 'redact_errored' | 'audit_callback_errored',
    err: unknown,
  ): string {
    if (type === 'redact_errored') {
      return REDACT_ERROR_MESSAGE;
    }
    try {
      if (err instanceof Error) return err.message;
      return String(err);
    } catch {
      return AUDIT_CALLBACK_NON_COERCIBLE_MESSAGE;
    }
  }

  private isValidAuditEvent(value: unknown): value is AuditEvent {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as AuditEvent).id === 'string' &&
      typeof (value as AuditEvent).timestamp === 'string' &&
      typeof (value as AuditEvent).type === 'string' &&
      typeof (value as AuditEvent).functionName === 'string'
    );
  }

  private pushBounded(event: AuditEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  getAll(): AuditEvent[] {
    return [...this.events];
  }

  exportJSON(): string {
    return JSON.stringify(this.events, null, 2);
  }

  clear(): void {
    this.events = [];
  }
}
