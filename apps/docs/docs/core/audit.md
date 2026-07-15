---
sidebar_position: 5
---

# Audit log

Every meaningful step is recorded: the LLM request, each tool request, validation outcomes,
confirmations, tool results, and errors. The log is a **bounded ring** (default 1000 events, oldest
dropped) so it can't grow unbounded in a long-lived browser session.

## Subscribing

Wire the per-event callback at construction, or read the whole bounded log after the fact:

```ts
const agent = createAgent({
  // ...
  audit: {
    onEvent: (event) => {
      // streamed, in order (post-redaction)
      console.log(event.type, event);
    },
  },
});

// or read after the fact
const events = agent.getAuditLog();
```

A throwing `onEvent` callback is caught and recorded as an `audit_callback_errored` event — **audit
callbacks must never break the tool loop**. Wrap your own side effects in try/catch if you want,
but you don't have to defend the loop itself.

## Event taxonomy

Events carry an `AuditEventType` and a typed payload. The broad categories:

- **Request lifecycle** — the chat request to the LLM and its outcome.
- **Tool requests** — `function_requested` for each tool call (in input order, even though handlers
  run concurrently).
- **Validation** — `validation_*` events when args fail the schema (the call is rejected before the
  handler ever runs).
- **Confirmation** — when `onConfirmRequired` is consulted for a `write`/`destructive` tool.
- **Results** — `function_errored` for throwing handlers; `function_executed` otherwise.
  Non-serializable handler results are caught and replaced with a placeholder + an audit event, so
  one bad tool can't poison the message history.

## Order in the presence of concurrency

`executeToolCalls` runs handlers **concurrently** via `Promise.allSettled`, but each call buffers
its audit events and the post-await flush re-emits them **in input order**. So even when call #3
finishes before call #1, the audit log reads in the order the model requested them.

## Redaction

```ts
createAgent({
  audit: {
    maxEvents: 1000,
    redact: (event) => {
      // return a sanitized copy, or the event unchanged
      if ('args' in event && event.functionName === 'addTask') {
        return { ...event, args: { title: '[redacted]' } };
      }
      return event;
    },
  },
});
```

`redact` runs **before** storage and **before** `onEvent` — so both the in-memory log and your live
subscriber see the redacted form. The original is never stored.

See the API reference for `AuditEvent`, `AuditEventType`, and `AuditConfig`.