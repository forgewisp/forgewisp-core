import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { HttpClient } from '../src/http.js';
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
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'gpt-4o', requestTimeoutMs: 0 });
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

  it('throws a descriptive error when the response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream down', { status: 503 }));
    const client = new HttpClient({ llmEndpoint: 'https://x', model: 'm', requestTimeoutMs: 0 });
    await expect(client.post(messages, [], false)).rejects.toThrow(
      '[Forgewisp] LLM request failed (503): upstream down',
    );
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
});