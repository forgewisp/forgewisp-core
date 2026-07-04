import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { HttpError, HttpClient, isHttpError } from '../src/http.js';
import type { LLMMessage, LLMTool } from '../src/wire.js';

const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }];
const tools: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'ping',
      description: 'Ping',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

function okResponse(): Response {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function lastCall(fetchMock: Mock): [string, RequestInit] {
  const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
  return calls[0]!;
}

describe('HttpClient', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ── buildRequestBody ──────────────────────────────────────────────────────

  it('injects stream_options.include_usage when stream is true', async () => {
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    await client.post(messages, [], true);
    const body = JSON.parse(lastCall(fetchMock)[1].body as string) as Record<string, unknown>;
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
  });

  it('omits stream_options when stream is false', async () => {
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    await client.post(messages, [], false);
    const body = JSON.parse(lastCall(fetchMock)[1].body as string) as Record<string, unknown>;
    expect(body['stream']).toBe(false);
    expect(body['stream_options']).toBeUndefined();
  });

  it('includes tools and tool_choice when tools are non-empty', async () => {
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    await client.post(messages, tools, false);
    const body = JSON.parse(lastCall(fetchMock)[1].body as string) as Record<string, unknown>;
    expect(body['tools']).toEqual(tools);
    expect(body['tool_choice']).toBe('auto');
  });

  it('omits tools and tool_choice when the tools array is empty', async () => {
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    await client.post(messages, [], false);
    const body = JSON.parse(lastCall(fetchMock)[1].body as string) as Record<string, unknown>;
    expect(body['tools']).toBeUndefined();
    expect(body['tool_choice']).toBeUndefined();
  });

  it('always sets model and messages in the body', async () => {
    const client = new HttpClient({
      llmEndpoint: 'https://x',
      model: 'gpt-4o',
      requestTimeoutMs: 0,
    });
    await client.post(messages, [], false);
    const body = JSON.parse(lastCall(fetchMock)[1].body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o');
    expect(body['messages']).toEqual(messages);
  });

  // ── buildHeaders ───────────────────────────────────────────────────────────

  it('sends Authorization: Bearer when apiKey is set', async () => {
    const client = new HttpClient({
      llmEndpoint: 'https://x',
      model: 'm',
      apiKey: 'sk-test',
      requestTimeoutMs: 0,
    });
    await client.post(messages, [], false);
    const headers = lastCall(fetchMock)[1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer sk-test');
  });

  it('omits Authorization when apiKey is absent (proxy / no-auth endpoint)', async () => {
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    await client.post(messages, [], false);
    const headers = lastCall(fetchMock)[1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBeUndefined();
  });

  // ── non-ok response ───────────────────────────────────────────────────────

  it('throws an HttpError (non-retryable) for a non-retryable status, without retrying', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    const promise = client.post(messages, [], false);
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await expect(promise).rejects.toMatchObject({
      name: 'HttpError',
      status: 400,
      isRetryable: false,
      body: 'bad request',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('isHttpError narrows HttpError and rejects other errors', () => {
    expect(isHttpError(new HttpError(503, 'x', true))).toBe(true);
    expect(isHttpError(new Error('nope'))).toBe(false);
    expect(isHttpError('string')).toBe(false);
  });

  // ── signalFor / mergeAbortSignals ──────────────────────────────────────────

  it('returns undefined when there is no timeout and no external signal', () => {
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    expect(client.signalFor(undefined)).toBeUndefined();
  });

  it('propagates an already-aborted external signal immediately', () => {
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    const ac = new AbortController();
    ac.abort(new Error('user cancelled'));
    const signal = client.signalFor(ac.signal);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBeInstanceOf(Error);
  });

  it('aborts the merged signal when the external signal aborts after wiring', () => {
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    const ac = new AbortController();
    const signal = client.signalFor(ac.signal);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    ac.abort();
    expect(signal!.aborted).toBe(true);
  });

  it('returns a non-aborted signal when both timeout and external signal are present and quiet', () => {
    vi.useFakeTimers();
    const client = new HttpClient({
      llmEndpoint: 'https://x',
      model: 'm',
      requestTimeoutMs: 60_000,
    });
    const ac = new AbortController();
    const signal = client.signalFor(ac.signal);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
  });

  it('aborts the merged signal after the timeout elapses (timeout-only path)', () => {
    vi.useFakeTimers();
    const client = new HttpClient({
      llmEndpoint: 'https://x',
      model: 'm',
      requestTimeoutMs: 100,
    });
    const signal = client.signalFor(undefined);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    vi.advanceTimersByTime(100);
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBeInstanceOf(Error);
  });

  it('does not pass a signal to fetch when none is provided and timeout is disabled', async () => {
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    await client.post(messages, [], false);
    const init = lastCall(fetchMock)[1];
    expect(init).not.toHaveProperty('signal');
  });

  // ── retry / backoff / Retry-After ───────────────────────────────────────────
  //
  // These tests use fake timers + a Math.random spy so backoff delays are
  // deterministic. Full-jitter backoff = random() * min(base * 2^(attempt-1), max);
  // spying random at 0.5 yields base*2^(attempt-1)*0.5 for the no-Retry-After path.

  describe('retry / backoff', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    it('retries a 503 then succeeds and returns the ok response', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('upstream down', { status: 503 }))
        .mockResolvedValueOnce(okResponse());
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        retryBackoffBaseMs: 500,
      });

      const pending = client.post(messages, [], false);
      // attempt 1: backoffDelay = 0.5 * 500 = 250
      await vi.advanceTimersByTimeAsync(250);
      const { response } = await pending;

      expect(response.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('exhausts the retry budget on persistent 503 and throws HttpError(503, isRetryable=true)', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response('upstream down', { status: 503 })),
      );
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        maxRetries: 3,
        retryBackoffBaseMs: 500,
      });

      const pending = client.post(messages, [], false);
      pending.catch(() => {}); // suppress unhandled rejection until the assert below
      // 3 retries: delays 250 (0.5*500), 500 (0.5*1000), 1000 (0.5*2000)
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(pending).rejects.toMatchObject({
        name: 'HttpError',
        status: 503,
        isRetryable: true,
        body: 'upstream down',
      });
      // 1 initial + 3 retries
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('retries a 429 and honors a Retry-After header in seconds', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '2' },
          }),
        )
        .mockResolvedValueOnce(okResponse());
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        retryBackoffBaseMs: 500,
      });

      const pending = client.post(messages, [], false);
      // Retry-After: 2 → 2000ms (no jitter on the Retry-After path)
      await vi.advanceTimersByTimeAsync(1999);
      await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      const { response } = await pending;

      expect(response.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('honors a Retry-After HTTP-Date instead of seconds', async () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const retryAfterDate = new Date(Date.now() + 3000).toUTCString();
      fetchMock
        .mockResolvedValueOnce(
          new Response('rate limited', {
            status: 503,
            headers: { 'Retry-After': retryAfterDate },
          }),
        )
        .mockResolvedValueOnce(okResponse());
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        retryBackoffBaseMs: 500,
      });

      const pending = client.post(messages, [], false);
      await vi.advanceTimersByTimeAsync(3000);
      const { response } = await pending;

      expect(response.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to backoff when Retry-After is malformed', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('rate limited', {
            status: 503,
            headers: { 'Retry-After': 'not-a-date-or-number' },
          }),
        )
        .mockResolvedValueOnce(okResponse());
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        retryBackoffBaseMs: 500,
      });

      const pending = client.post(messages, [], false);
      // malformed Retry-After → backoff path: 0.5 * 500 = 250
      await vi.advanceTimersByTimeAsync(250);
      const { response } = await pending;

      expect(response.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to backoff when no Retry-After header is present', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('upstream down', { status: 504 }))
        .mockResolvedValueOnce(okResponse());
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        retryBackoffBaseMs: 500,
      });

      const pending = client.post(messages, [], false);
      await vi.advanceTimersByTimeAsync(250);
      const { response } = await pending;

      expect(response.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a network reset (fetch TypeError) then succeeds', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(okResponse());
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        retryBackoffBaseMs: 500,
      });

      const pending = client.post(messages, [], false);
      await vi.advanceTimersByTimeAsync(250);
      const { response } = await pending;

      expect(response.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('exhausts the retry budget on persistent network resets and throws HttpError(0, isRetryable=true)', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        maxRetries: 2,
        retryBackoffBaseMs: 500,
      });

      const pending = client.post(messages, [], false);
      pending.catch(() => {}); // suppress unhandled rejection until the assert below
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(500);

      await expect(pending).rejects.toMatchObject({
        name: 'HttpError',
        status: 0,
        isRetryable: true,
      });
      // 1 initial + 2 retries
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not retry when the fetch rejects because the signal aborted', async () => {
      const ac = new AbortController();
      fetchMock.mockRejectedValue(
        (() => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          return e;
        })(),
      );
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        maxRetries: 3,
      });
      ac.abort(new Error('user cancelled'));

      // The already-aborted signal makes fetch reject; post surfaces the
      // signal's abort reason (not the fetch error) without retrying.
      await expect(client.post(messages, [], false, ac.signal)).rejects.toThrow('user cancelled');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('aborts mid-backoff: no further retry, surfaces the abort reason', async () => {
      const ac = new AbortController();
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response('upstream down', { status: 503 })),
      );
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        maxRetries: 3,
        retryBackoffBaseMs: 500,
      });

      const pending = client.post(messages, [], false, ac.signal);
      pending.catch(() => {}); // suppress unhandled rejection until the assert below
      // advance partway through the first backoff (250ms), then abort
      await vi.advanceTimersByTimeAsync(100);
      ac.abort(new Error('user cancelled'));
      await vi.advanceTimersByTimeAsync(200);

      await expect(pending).rejects.toThrow('user cancelled');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('renews the per-attempt timeout each retry (timeout does not bound the whole sequence)', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('upstream down', { status: 503 }))
        .mockResolvedValueOnce(okResponse());
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 100, // per-attempt timeout
        retryBackoffBaseMs: 500, // backoff 250ms (0.5 * 500) > 100ms timeout
      });

      const pending = client.post(messages, [], false);
      pending.catch(() => {});
      // The 250ms backoff exceeds the 100ms per-attempt timeout. Under the old
      // single-merged-signal design the timeout would fire mid-backoff and
      // surface "Request timed out." Instead the timeout is disarmed during
      // backoff, the backoff completes, and the retry succeeds.
      await vi.advanceTimersByTimeAsync(250);
      const { response } = await pending;

      expect(response.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('surfaces an abort during response.text() instead of masking it as an HttpError', async () => {
      const ac = new AbortController();
      const resp = new Response('bad request', { status: 400 });
      // Simulate the body stream aborting mid-read (fetch returned headers, but
      // text() rejects because the signal aborted during body consumption).
      vi.spyOn(resp, 'text').mockRejectedValue(
        (() => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          return e;
        })(),
      );
      fetchMock.mockResolvedValueOnce(resp);
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        maxRetries: 3,
      });
      ac.abort(new Error('user cancelled'));

      // Without the post-text abort re-check, the .catch(() => '') on text()
      // would swallow the AbortError and a 400 would surface as HttpError(400).
      await expect(client.post(messages, [], false, ac.signal)).rejects.toThrow('user cancelled');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('maxRetries: 0 disables retry (fail-fast on a retryable status)', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response('upstream down', { status: 503 })),
      );
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        requestTimeoutMs: 0,
        maxRetries: 0,
      });

      await expect(client.post(messages, [], false)).rejects.toMatchObject({
        name: 'HttpError',
        status: 503,
        isRetryable: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('scrubs the apiKey, Bearer tokens, and Authorization lines from the HttpError body', async () => {
      const body = `{"error":"key sk-secret-key is invalid","auth":"Bearer abcdef123","header":"Authorization: Bearer xyz"}`;
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 500 }));
      const client = new HttpClient({
        llmEndpoint: 'https://x',
        model: 'm',
        apiKey: 'sk-secret-key',
        requestTimeoutMs: 0,
      });

      const promise = client.post(messages, [], false);
      await expect(promise).rejects.toBeInstanceOf(HttpError);
      const err = (await promise.catch((e: unknown) => e)) as HttpError;
      expect(err.body).not.toContain('sk-secret-key');
      expect(err.body).not.toContain('abcdef123');
      expect(err.body).not.toContain('Bearer xyz');
      expect(err.body).toContain('[REDACTED]');
      expect(fetchMock).toHaveBeenCalledTimes(1); // 500 is non-retryable
    });
  });
});
