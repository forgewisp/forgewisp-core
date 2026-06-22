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

// Builds an SSE Response whose deltas carry one tool call each (assembled by the
// streaming parser by `index`). The `arguments` strings are raw JSON, as the
// OpenAI API sends them.
function sseToolCallsResponse(calls: Array<{ name: string; arguments: string }>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      calls.forEach((c, i) => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: i,
                        id: `call_${i + 1}`,
                        function: { name: c.name, arguments: c.arguments },
                      },
                    ],
                  },
                },
              ],
            })}\n`,
          ),
        );
      });
      controller.enqueue(encoder.encode('data: [DONE]\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

// Loads the full bundled-demo body so main.ts's getEl() lookups succeed at import.
const DEMO_BODY = `
  <div class="app">
    <aside class="sidebar">
      <div id="tools-list"></div>
      <ul id="artifacts-list" aria-label="Tool artifacts"></ul>
      <button type="button" id="clear-artifacts-btn">Clear</button>
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

const CONFIG_KEY = 'forgewisp.bundled-demo.config';
const VALID_CONFIG = { endpoint: 'https://llm.example/v1/chat', model: 'gpt-4o', apiKey: 'k' };

// copyToClipboard needs navigator.clipboard.writeText, which jsdom lacks. Stub
// it once per test that drives a clipboard tool call.
function stubClipboard(): Mock<[string], Promise<void>> {
  const writeText = vi.fn<[string], Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

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

describe('multi-tool confirmation chain', () => {
  let writeText: Mock<[string], Promise<void>>;

  beforeAll(async () => {
    vi.resetModules();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(VALID_CONFIG));
    document.body.innerHTML = DEMO_BODY;
    writeText = stubClipboard();

    // First request returns a read tool (getCurrentTime) + a write tool
    // (copyToClipboard) in one assistant turn; subsequent requests return a
    // plain final reply so the tool loop terminates.
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          sseToolCallsResponse([
            { name: 'getCurrentTime', arguments: JSON.stringify({}) },
            { name: 'copyToClipboard', arguments: JSON.stringify({ text: 'hello world' }) },
          ]),
        );
      }
      return Promise.resolve(sseResponse('done'));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('runs the read tool without confirmation and confirms the write tool', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const overlay = document.getElementById('confirm-overlay') as HTMLDivElement;
    const accept = document.getElementById('confirm-accept') as HTMLButtonElement;
    const artifacts = document.getElementById('artifacts-list') as HTMLUListElement;

    input.value = 'time and clipboard';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));

    // The confirm dialog shows for copyToClipboard (write) — getCurrentTime (read)
    // does not trigger a confirmation.
    await vi.waitFor(() => expect(overlay.classList.contains('hidden')).toBe(false));
    expect(document.getElementById('confirm-description')?.textContent).toContain(
      'copyToClipboard',
    );
    expect(writeText).not.toHaveBeenCalled();

    // Accepting runs the clipboard handler.
    accept.click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('hello world'));

    // The clipboard artifact card appears (rendered from the function_executed
    // audit event via onAuditEvent).
    await vi.waitFor(() => {
      const clip = artifacts.querySelector('.artifact-copyToClipboard');
      expect(clip).not.toBeNull();
      expect(clip?.textContent).toContain('Copied to clipboard');
    });
  });
});

describe('confirmation rejection', () => {
  let writeText: Mock<[string], Promise<void>>;

  beforeAll(async () => {
    vi.resetModules();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(VALID_CONFIG));
    document.body.innerHTML = DEMO_BODY;
    writeText = stubClipboard();

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          sseToolCallsResponse([
            { name: 'copyToClipboard', arguments: JSON.stringify({ text: 'nope' }) },
          ]),
        );
      }
      return Promise.resolve(sseResponse('okay'));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('does not run the handler when the user rejects', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const overlay = document.getElementById('confirm-overlay') as HTMLDivElement;
    const reject = document.getElementById('confirm-reject') as HTMLButtonElement;
    const auditLog = document.getElementById('audit-log') as HTMLUListElement;

    input.value = 'copy something';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));

    await vi.waitFor(() => expect(overlay.classList.contains('hidden')).toBe(false));
    reject.click();

    // The handler must NOT have run.
    await vi.waitFor(() => expect(writeText).not.toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();

    // A confirmation_rejected audit event is recorded.
    await vi.waitFor(() => {
      const types = Array.from(auditLog.querySelectorAll('.audit-type')).map(
        (el) => el.textContent ?? '',
      );
      expect(types).toContain('rejected');
    });
  });
});
