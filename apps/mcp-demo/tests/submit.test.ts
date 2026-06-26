import { describe, it, expect, beforeAll, vi, afterAll } from 'vitest';
import type { Mock } from 'vitest';

// Builds a non-streaming-style SSE Response whose `content` deltas concatenate
// to `text`. The demo agent is configured with streaming, so fetch must return
// an SSE stream (not JSON) for the run to complete.
function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

// Loads the full mcp-demo body so main.ts's getEl() lookups succeed at import.
const DEMO_BODY = `
  <div class="app">
    <aside class="sidebar">
      <form id="mcp-form">
        <input id="mcp-name" type="text" />
        <input id="mcp-url" type="url" />
        <select id="mcp-tier">
          <option value="read">read</option>
          <option value="write">write</option>
          <option value="destructive">destructive</option>
        </select>
        <input id="mcp-timeout" type="number" />
        <input id="mcp-apikey" type="password" />
        <input id="mcp-oauth" type="checkbox" />
        <button type="submit">Connect server</button>
      </form>
      <p id="mcp-status" aria-live="polite"></p>
      <ul id="mcp-servers-list"></ul>
      <div id="tools-list"></div>
      <section class="reasoning-section hidden" id="reasoning-section">
        <div id="reasoning-output"></div>
      </section>
      <h2>Audit <button type="button" id="clear-audit-btn">Clear</button></h2>
      <ul id="audit-log"></ul>
    </aside>
    <main>
      <div id="chat-messages" class="chat-messages" role="log" aria-live="polite"></div>
      <form id="chat-form" class="chat-form">
        <label class="sr-only" for="chat-input">Chat message</label>
        <input id="chat-input" type="text" autocomplete="off" />
        <button type="submit">Send</button>
      </form>
    </main>
  </div>
  <div id="config-overlay" class="overlay" role="dialog" aria-modal="true">
    <form id="config-form">
      <input id="config-endpoint" type="text" required />
      <input id="config-model" type="text" required />
      <input id="config-apikey" type="password" autocomplete="off" />
      <button type="submit">Connect</button>
    </form>
  </div>
  <div id="confirm-overlay" class="overlay hidden" role="dialog" aria-modal="true">
    <h3 id="confirm-title"></h3>
    <p id="confirm-description"></p>
    <div id="confirm-args"></div>
    <button type="button" id="confirm-accept">Confirm</button>
    <button type="button" id="confirm-reject">Cancel</button>
  </div>
`;

const CONFIG_KEY = 'forgewisp.mcp-demo.config';
const VALID_CONFIG = { endpoint: 'https://llm.example/v1/chat', model: 'gpt-4o', apiKey: 'k' };

describe('submit race guard', () => {
  beforeAll(async () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(VALID_CONFIG));
    document.body.innerHTML = DEMO_BODY;

    // Stub fetch with a never-resolving promise so agent.run stays in flight.
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {})) as typeof fetch;

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('blocks a second submit while a run is in flight', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const chat = document.getElementById('chat-messages');

    input.value = 'first message';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));

    // Let the synchronous portion of the handler run (sets inFlightController).
    await Promise.resolve();

    expect(chat!.querySelectorAll('.message-user').length).toBe(1);

    // Second submit while the first is still in flight.
    input.value = 'second message';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
    await Promise.resolve();

    // Race guard prevented the second message from being appended.
    expect(chat!.querySelectorAll('.message-user').length).toBe(1);
    expect(input.disabled).toBe(true);
  });
});

describe('chat history', () => {
  const recordedBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

  beforeAll(async () => {
    vi.resetModules();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(VALID_CONFIG));
    document.body.innerHTML = DEMO_BODY;

    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ role: string; content: string }>;
      };
      recordedBodies.push(body);
      const lastUser = body.messages[body.messages.length - 1];
      const reply = lastUser ? `reply to: ${lastUser.content}` : 'reply';
      return Promise.resolve(sseResponse(reply));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('threads prior turns into the next request as history', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;

    input.value = 'turn one';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.message-assistant:not(.thinking-indicator)').length).toBe(
        1,
      );
    });

    input.value = 'turn two';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => {
      expect(recordedBodies.length).toBeGreaterThanOrEqual(2);
      expect(document.querySelectorAll('.message-user').length).toBe(2);
    });

    const second = recordedBodies[recordedBodies.length - 1]!.messages;
    expect(second[0]!.role).toBe('system');
    expect(second).toContainEqual({ role: 'user', content: 'turn one' });
    expect(second).toContainEqual({ role: 'assistant', content: 'reply to: turn one' });
    expect(second[second.length - 1]).toEqual({ role: 'user', content: 'turn two' });
  });
});

describe('mcp form validation', () => {
  let fetchMock: Mock;

  beforeAll(async () => {
    vi.resetModules();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(VALID_CONFIG));
    document.body.innerHTML = DEMO_BODY;

    // Agent is built from stored config at boot. Track fetch calls so we can
    // prove the MCP connect path is never reached when validation fails.
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('rejects an empty name/url without connecting or hitting the network', () => {
    const form = document.getElementById('mcp-form') as HTMLFormElement;
    const nameInput = document.getElementById('mcp-name') as HTMLInputElement;
    const urlInput = document.getElementById('mcp-url') as HTMLInputElement;
    const status = document.getElementById('mcp-status') as HTMLParagraphElement;
    const serversList = document.getElementById('mcp-servers-list') as HTMLUListElement;

    const fetchCallsBefore = fetchMock.mock.calls.length;

    nameInput.value = '';
    urlInput.value = '';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));

    // Validation error surfaces, no server chip added, no fetch made.
    expect(status.textContent).toContain('required');
    expect(serversList.querySelectorAll('.mcp-server-chip').length).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(fetchCallsBefore);
  });
});
