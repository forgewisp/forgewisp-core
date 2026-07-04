import type { LLMMessage, LLMTool } from './wire.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
/**
 * Default base/max backoff delays (ms), shared with the loop layer so both
 * retry layers share one backoff curve. Exported for loop.ts to use as the
 * fallback when `http.retryBackoffBaseMs` / `retryBackoffMaxMs` are unset.
 */
export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_MAX_MS = 8_000;
const DEFAULT_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 503, 504]);
/** Cap on the scrubbed body stored on an HttpError, to keep error messages bounded. */
const MAX_ERROR_BODY_CHARS = 500;

export interface HttpClientOptions {
  llmEndpoint: string;
  apiKey?: string;
  model: string;
  /** Per-request timeout in milliseconds. Defaults to 60000. Set to 0 to disable. */
  requestTimeoutMs?: number;
  /** Max retry attempts after the first request. Defaults to 3. Set to 0 to disable retry. */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms). Defaults to 500. */
  retryBackoffBaseMs?: number;
  /**
   * Cap on per-attempt delay (ms). Defaults to 8000. Caps both the jittered
   * exponential backoff AND a server-directed `Retry-After` (the latter is
   * honored directly, then clamped to this cap).
   */
  retryBackoffMaxMs?: number;
  /** Status codes eligible for retry (in addition to network resets). Defaults to 429/503/504. */
  retryableStatusCodes?: ReadonlyArray<number>;
}

/**
 * Structured error thrown by `HttpClient.post` when the request fails after
 * exhausting the retry budget (or immediately for a non-retryable status).
 *
 * `status` is the HTTP status code, or `0` for a network-level failure (fetch
 * rejected with no response). `isRetryable` reflects whether the failure is
 * transient *by nature* (retryable status or network reset) — NOT whether the
 * retry budget still had room — so callers can branch on it (e.g. a higher
 * layer may retry after a longer delay). `body` is the response body scrubbed
 * of secrets (configured apiKey, `Bearer` tokens, `Authorization` headers) and
 * truncated, so it is safe to log or surface.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly isRetryable: boolean;
  readonly body: string;

  constructor(status: number, body: string, isRetryable: boolean, message?: string) {
    super(message ?? `[Forgewisp] LLM request failed (${status}): ${body}`);
    this.name = 'HttpError';
    this.status = status;
    this.isRetryable = isRetryable;
    this.body = body;
  }
}

/** Type guard for `HttpError`. */
export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

/**
 * Combines an optional external AbortSignal with a per-attempt timeout into a
 * single signal. Returns `{ signal: undefined, clear: noop }` when neither is
 * provided. `clear` cancels the timeout timer WITHOUT aborting the signal —
 * used to discard a per-attempt handle between retries (so the timeout does
 * not fire during backoff) while leaving the response body of a successful
 * attempt bound to its signal (so the timeout keeps covering streaming).
 */
function mergeAbortSignals(
  timeoutMs?: number,
  external?: AbortSignal,
): { signal: AbortSignal | undefined; clear: () => void } {
  if (!timeoutMs && !external) return { signal: undefined, clear: () => {} };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
  };
  if (external) {
    if (external.aborted) {
      controller.abort((external as { reason?: unknown }).reason);
    } else {
      external.addEventListener(
        'abort',
        () => controller.abort((external as { reason?: unknown }).reason),
        { once: true },
      );
    }
  }
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(
      () => controller.abort(new Error('[Forgewisp] Request timed out.')),
      timeoutMs,
    );
    controller.signal.addEventListener('abort', () => clear(), { once: true });
  }
  return { signal: controller.signal, clear };
}

/** Coerces an abort reason into an Error (AbortSignal.reason is `unknown`). */
function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('[Forgewisp] Aborted.');
}

/** Resolves after `ms`, rejecting early with the signal's reason if it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Parses a `Retry-After` header value into milliseconds. Accepts either
 * delta-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns `undefined` for a missing or malformed value. Negative or past
 * HTTP-dates clamp to 0 (retry immediately).
 */
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - now);
}

/**
 * Full-jitter exponential backoff delay for a given 1-based attempt index.
 * `delay = random() * min(base * 2^(attempt-1), max)`. Exported so the loop
 * layer reuses the exact same backoff shape — one curve, implemented once.
 */
export function backoffDelay(attempt: number, base: number, max: number): number {
  const exp = Math.min(base * 2 ** (attempt - 1), max);
  return Math.random() * exp;
}

/**
 * Scrubs secrets out of a response body before it is surfaced in an
 * `HttpError`. Redacts the configured `apiKey` substring, `Bearer <token>`
 * patterns, and `Authorization: <creds>` lines, then truncates to
 * `MAX_ERROR_BODY_CHARS`. Best-effort — never throws.
 */
function scrubSecrets(text: string, apiKey?: string): string {
  let out = text;
  try {
    if (apiKey && apiKey.length > 0) {
      out = out.split(apiKey).join('[REDACTED]');
    }
    out = out.replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]');
    out = out.replace(/Authorization:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]');
  } catch {
    // ignore — scrubbing is best-effort
  }
  if (out.length > MAX_ERROR_BODY_CHARS) {
    out = `${out.slice(0, MAX_ERROR_BODY_CHARS)}…`;
  }
  return out;
}

/**
 * HTTP client for OpenAI-compatible chat-completions endpoints. Owns request
 * body construction, header construction, fetch invocation, and abort/timeout
 * wiring. Returns the raw Response; the caller decides streaming vs JSON.
 *
 * Retries idempotently at the request layer only: a 429/503/504 response or a
 * network reset triggers a bounded number of retries with exponential backoff
 * + jitter, honoring `Retry-After` when present. Tool-call side effects are
 * never re-issued from here — only the HTTP request is retried.
 */
export class HttpClient {
  private opts: HttpClientOptions;
  private retryableStatusCodes: ReadonlySet<number>;

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
    this.retryableStatusCodes = opts.retryableStatusCodes
      ? new Set(opts.retryableStatusCodes)
      : DEFAULT_RETRYABLE_STATUS_CODES;
  }

  /**
   * POST the chat-completions request, retrying idempotently at the request
   * layer on 429/503/504 or a network reset. `externalSignal` is the caller's
   * abort signal (user cancel / run abort); the per-attempt timeout is applied
   * internally and refreshed each attempt, so `requestTimeoutMs` bounds a
   * single attempt (fetch + body read), NOT the whole retry sequence. Backoff
   * sleeps wait on `externalSignal` only — the timeout never fires mid-backoff.
   *
   * Returns the successful `Response` plus the per-attempt signal that was
   * passed to `fetch` (still armed with its timeout), so the caller can apply
   * the same timeout to streaming / body consumption. `signal` is `undefined`
   * when neither a timeout nor an external signal is configured.
   */
  async post(
    messages: LLMMessage[],
    tools: LLMTool[],
    stream: boolean,
    externalSignal?: AbortSignal,
  ): Promise<{ response: Response; signal: AbortSignal | undefined }> {
    const body = this.buildRequestBody(messages, tools, stream);
    const headers = this.buildHeaders();

    const maxRetries = this.opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const base = this.opts.retryBackoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const max = this.opts.retryBackoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    let attempt = 0;
    // First attempt is attempt 0; retries increment before sleeping.
    for (;;) {
      // Fresh per-attempt signal: the timeout timer is re-armed each attempt,
      // so a slow first attempt that 503s does not consume the second attempt's
      // timeout budget.
      const handle = mergeAbortSignals(timeoutMs, externalSignal);
      let response: Response;
      try {
        response = await fetch(this.opts.llmEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          ...(handle.signal ? { signal: handle.signal } : {}),
        });
      } catch (err) {
        // If the run was aborted (user cancel or timeout), do not retry —
        // surface the abort reason immediately.
        if (handle.signal?.aborted) {
          handle.clear();
          throw abortError(handle.signal.reason);
        }
        if (attempt >= maxRetries) {
          handle.clear();
          throw new HttpError(
            0,
            '',
            true,
            `[Forgewisp] LLM request failed after ${attempt + 1} attempts (network error): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        handle.clear();
        attempt++;
        // Sleep on the external signal only — the per-attempt timeout is
        // disarmed, so backoff is not truncated by requestTimeoutMs.
        await sleep(backoffDelay(attempt, base, max), externalSignal);
        continue;
      }

      if (response.ok) {
        // Leave the per-attempt signal armed so its timeout keeps covering
        // the caller's streaming / body consumption.
        return { response, signal: handle.signal };
      }

      const raw = await response.text().catch(() => '');
      // An abort during body consumption would otherwise be swallowed by the
      // .catch above and masked as an HttpError — surface the abort reason.
      if (handle.signal?.aborted) {
        handle.clear();
        throw abortError(handle.signal.reason);
      }
      const scrubbed = scrubSecrets(raw, this.opts.apiKey);
      const retryable = this.retryableStatusCodes.has(response.status);

      if (retryable && attempt < maxRetries) {
        handle.clear();
        attempt++;
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
        const delay =
          retryAfterMs !== undefined
            ? Math.min(retryAfterMs, max)
            : backoffDelay(attempt, base, max);
        await sleep(delay, externalSignal);
        continue;
      }

      handle.clear();
      throw new HttpError(response.status, scrubbed, retryable);
    }
  }

  /**
   * Merges the per-attempt timeout with an external signal into one signal.
   * Convenience wrapper around `mergeAbortSignals` for callers that only need
   * the signal (the timer self-clears on abort).
   */
  signalFor(externalSignal?: AbortSignal): AbortSignal | undefined {
    return mergeAbortSignals(
      this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      externalSignal,
    ).signal;
  }

  private buildRequestBody(
    messages: LLMMessage[],
    tools: LLMTool[],
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      stream,
    };

    if (stream) {
      body.stream_options = { include_usage: true }; // needed for reasoning_tokens on o1/o3
    }

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    return body;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.opts.apiKey) {
      headers['Authorization'] = `Bearer ${this.opts.apiKey}`;
    }

    return headers;
  }
}
