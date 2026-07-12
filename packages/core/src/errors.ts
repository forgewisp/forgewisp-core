/**
 * Coerces a thrown value into a human-readable message string. The single
 * shared coercer for every `catch (err: unknown)` site in core that needs to
 * surface the failure as a `string` (audit events, abort errors, validation
 * failures, stream-malformed notices). Centralizing this prevents the
 * coercion shape from drifting across the handful of sites that previously
 * inlined `err instanceof Error ? err.message : String(err)`.
 *
 * Behavior:
 * - `Error` → its `.message` (may be empty; callers needing a non-empty
 *   guarantee layer their own fallback).
 * - `string` → the string itself.
 * - `undefined`/`null` → a concrete placeholder, never the JS value
 *   `undefined` (which JSON-stringifies to nothing and would violate a
 *   `: string` return contract, breaking `result.error.includes(...)`).
 * - number/boolean/bigint → `String(value)`.
 * - object/array/function/symbol → a JSON form when serializable, else a
 *   placeholder (avoids the unhelpful `[object Object]`).
 *
 * NOT used by the audit log's `redact_errored` / `audit_callback_errored`
 * path (`audit.ts#coerceErrorMessage`): that path is deliberately opaque by
 * type (a redactor thrown on the unredacted event may echo a secret) and
 * guards against a throwing `toString`/`message` getter, so it keeps its own
 * type-keyed, try/catch-wrapped coercer. `toErrorMessage` is the
 * general-purpose path for values known to be ordinary Errors/primitives.
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  // `undefined`/`null` reach here when a retry loop never entered (e.g. a
  // NaN/negative `loopRetries` slipped past the agent-layer guard) so
  // `lastError` was never assigned — return a concrete string rather than the
  // JS value `undefined` (JSON.stringify(undefined) === undefined), which would
  // violate the `: string` return type and break consumers doing
  // `result.error.includes(...)`.
  if (err === undefined || err === null) return '[Forgewisp] Unknown error.';
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return String(err);
  }
  // An object, array, function, or symbol. Prefer a JSON form (the common case
  // for a thrown plain object like `{ code: 500 }`); if it isn't JSON-serializable
  // (circular) or JSON.stringify returns the value `undefined` (function/symbol),
  // fall back to a concrete placeholder instead of `[object Object]`.
  try {
    const s = JSON.stringify(err);
    return s === undefined ? '[Forgewisp] Unknown error.' : s;
  } catch {
    return '[Forgewisp] Unknown error.';
  }
}
