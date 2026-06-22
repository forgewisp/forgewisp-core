import { AuditEvent, AuditEventType } from './types.js';

const DEFAULT_MAX_EVENTS = 1000;

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
    const event = this.redact ? this.redact(raw) : raw;
    this.pushBounded(event);
    try {
      this.onEvent?.(event);
    } catch (err) {
      // A throwing audit callback must never break the tool-call loop.
      // Record a synthetic event directly (do not re-invoke the callback).
      this.pushBounded({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'audit_callback_errored',
        functionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return event;
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
