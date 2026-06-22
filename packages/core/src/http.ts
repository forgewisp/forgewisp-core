import type { LLMMessage, LLMTool } from './wire.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface HttpClientOptions {
  llmEndpoint: string;
  apiKey?: string;
  model: string;
  /** Per-request timeout in milliseconds. Defaults to 60000. Set to 0 to disable. */
  requestTimeoutMs?: number;
}

/**
 * Combines an optional external AbortSignal with a per-request timeout into a
 * single signal. Returns undefined when neither is provided.
 */
function mergeAbortSignals(timeoutMs?: number, external?: AbortSignal): AbortSignal | undefined {
  if (!timeoutMs && !external) return undefined;
  const controller = new AbortController();
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
    const timer = setTimeout(
      () => controller.abort(new Error('[Forgewisp] Request timed out.')),
      timeoutMs,
    );
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
  return controller.signal;
}

/**
 * HTTP client for OpenAI-compatible chat-completions endpoints. Owns request
 * body construction, header construction, fetch invocation, and abort/timeout
 * wiring. Returns the raw Response; the caller decides streaming vs JSON.
 */
export class HttpClient {
  private opts: HttpClientOptions;

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
  }

  async post(
    messages: LLMMessage[],
    tools: LLMTool[],
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    const body = this.buildRequestBody(messages, tools, stream);
    const headers = this.buildHeaders();

    const response = await fetch(this.opts.llmEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[Forgewisp] LLM request failed (${response.status}): ${text}`);
    }

    return response;
  }

  /** Merges the per-request timeout with an external signal into one signal. */
  signalFor(externalSignal?: AbortSignal): AbortSignal | undefined {
    return mergeAbortSignals(
      this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      externalSignal,
    );
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
