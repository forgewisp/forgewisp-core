import { describe, it, expect, beforeAll, vi, afterAll } from 'vitest';

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

// Builds an AbortError like the one fetch rejects with when its signal aborts.
// The http layer checks `signal.aborted` (not the error name), but a real
// AbortError is the faithful shape.
function makeAbortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

// Loads the full demo body so main.ts's getEl() lookups succeed at import time.
const DEMO_BODY = `
  <div class="app">
    <aside class="sidebar">
      <ul id="task-list"></ul>
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

describe('submit race guard', () => {
  beforeAll(async () => {
    // Pre-seed a valid config so main.ts auto-builds an agent on import.
    localStorage.setItem(
      'forgewisp.demo.config',
      JSON.stringify({ endpoint: 'https://llm.example/v1/chat', model: 'gpt-4o', apiKey: 'k' }),
    );
    document.body.innerHTML = DEMO_BODY;

    // Stub fetch with a never-resolving promise so agent.run stays in flight.
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    globalThis.fetch = fetchMock;

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
    // Discard the cached module: the run above never resolves (its fetch ignores
    // the signal), so inFlightController stays set in the module closure. Without
    // a reset, a later describe that reuses this cached module without its own
    // resetModules would have every submit silently blocked by the race guard.
    vi.resetModules();
  });

  it('blocks a second submit while a run is in flight', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const chat = document.getElementById('chat-messages');

    input.value = 'first message';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));

    // Let the synchronous portion of the handler run (sets inFlightController).
    await Promise.resolve();

    const userMessagesAfterFirst = chat!.querySelectorAll('.message-user').length;
    expect(userMessagesAfterFirst).toBe(1);

    // Second submit while the first is still in flight.
    input.value = 'second message';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
    await Promise.resolve();

    const userMessagesAfterSecond = chat!.querySelectorAll('.message-user').length;
    // Race guard prevented the second message from being appended.
    expect(userMessagesAfterSecond).toBe(1);

    // The input should also be disabled during the run.
    expect(input.disabled).toBe(true);
  });
});

describe('chat history', () => {
  beforeAll(async () => {
    // Fresh module so its module-level `conversation` array starts empty and
    // our resolving fetch stub applies (the race-guard test used a never-resolving one).
    vi.resetModules();
    localStorage.setItem(
      'forgewisp.demo.config',
      JSON.stringify({ endpoint: 'https://llm.example/v1/chat', model: 'gpt-4o', apiKey: 'k' }),
    );
    document.body.innerHTML = DEMO_BODY;

    // Record each request body so we can assert what messages were sent.
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ role: string; content: string }>;
      };
      recordedBodies.push(body);
      // Echo a deterministic reply so the run completes and the turn is recorded.
      const lastUser = body.messages[body.messages.length - 1];
      const reply = lastUser ? `reply to: ${lastUser.content}` : 'reply';
      return Promise.resolve(sseResponse(reply));
    });
    globalThis.fetch = fetchMock;

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  const recordedBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

  it('threads prior turns into the next request as history', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;

    // First turn.
    input.value = 'turn one';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
    // Wait for the assistant bubble — it only exists after the run's `finally`
    // has cleared the in-flight guard, so the next submit won't be raced out.
    // Exclude the transient "Thinking…" placeholder (also `.message-assistant`),
    // which is shown immediately on submit and removed on the first token / in
    // `finally`; it is not a completed assistant message.
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.message-assistant:not(.thinking-indicator)').length).toBe(
        1,
      );
    });

    // Second turn.
    input.value = 'turn two';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => {
      expect(recordedBodies.length).toBeGreaterThanOrEqual(2);
      expect(document.querySelectorAll('.message-user').length).toBe(2);
    });

    const second = recordedBodies[recordedBodies.length - 1]!.messages;
    // [system, {user:'turn one'}, {assistant:'reply to: turn one'}, {user:'turn two'}]
    expect(second[0]!.role).toBe('system');
    expect(second).toContainEqual({ role: 'user', content: 'turn one' });
    expect(second).toContainEqual({ role: 'assistant', content: 'reply to: turn one' });
    expect(second[second.length - 1]).toEqual({ role: 'user', content: 'turn two' });
  });
});

describe('stop button', () => {
  beforeAll(async () => {
    vi.resetModules();
    localStorage.setItem(
      'forgewisp.demo.config',
      JSON.stringify({ endpoint: 'https://llm.example/v1/chat', model: 'gpt-4o', apiKey: 'k' }),
    );
    document.body.innerHTML = DEMO_BODY;

    // A fetch mock that hangs until the request's abort signal fires, then
    // rejects with an AbortError — mirroring the real fetch's abort behavior
    // so an in-flight run actually rejects when Stop is clicked.
    globalThis.fetch = vi.fn().mockImplementation(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal | undefined;
          if (signal?.aborted) {
            reject(makeAbortError());
            return;
          }
          signal?.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        }),
    );

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('aborts the in-flight run, surfaces a stopped state, and re-enables submit', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const sendButton = form.querySelector('button') as HTMLButtonElement;
    const chat = document.getElementById('chat-messages')!;

    input.value = 'long message';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
    // Let the synchronous portion of the handler run (sets inFlightController,
    // morphs the button to Stop).
    await Promise.resolve();

    expect(sendButton.textContent).toBe('Stop');
    expect(input.disabled).toBe(true);

    sendButton.click(); // click Stop

    await vi.waitFor(() => {
      expect(chat.querySelectorAll('.message-stopped').length).toBe(1);
    });
    expect(input.disabled).toBe(false);
    expect(sendButton.textContent).toBe('Send');
  });

  it('does not abort on the trailing click of a double-click on Send', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const sendButton = form.querySelector('button') as HTMLButtonElement;
    const chat = document.getElementById('chat-messages')!;

    input.value = 'long message';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
    // Synchronous portion: inFlightController set, button morphed to Stop.
    await Promise.resolve();
    // The DOM persists across tests in this describe, so capture the marker
    // count after submit and assert the trailing click does not add one.
    const stoppedBefore = chat.querySelectorAll('.message-stopped').length;

    // The second click of a double-click on Send (detail === 2) must NOT abort
    // the just-started run — it is part of the same gesture that sent, not a
    // genuine Stop (which is a fresh gesture with detail === 1).
    sendButton.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }),
    );
    await Promise.resolve();

    expect(chat.querySelectorAll('.message-stopped').length).toBe(stoppedBefore);
    expect(sendButton.textContent).toBe('Stop');
    expect(input.disabled).toBe(true);

    // Clean up: a genuine single Stop (programmatic .click() is detail 0) aborts.
    sendButton.click();
    await vi.waitFor(() => {
      expect(chat.querySelectorAll('.message-stopped').length).toBe(stoppedBefore + 1);
    });
  });
});

describe('stop during confirmation', () => {
  beforeAll(async () => {
    vi.resetModules();
    localStorage.setItem(
      'forgewisp.demo.config',
      JSON.stringify({ endpoint: 'https://llm.example/v1/chat', model: 'gpt-4o', apiKey: 'k' }),
    );
    document.body.innerHTML = DEMO_BODY;

    // First request returns a write-tier tool call (opens the confirm dialog).
    // Subsequent requests hang until aborted — Stop fires before round 2's
    // fetch completes, so the abort rejects it immediately.
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((_url, init: RequestInit) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          sseToolCallsResponse([{ name: 'addTask', arguments: JSON.stringify({ title: 'X' }) }]),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          reject(makeAbortError());
          return;
        }
        signal?.addEventListener('abort', () => reject(makeAbortError()), { once: true });
      });
    });

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('closes the open confirm dialog and surfaces a stopped state', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const sendButton = form.querySelector('button') as HTMLButtonElement;
    const overlay = document.getElementById('confirm-overlay') as HTMLDivElement;
    const chat = document.getElementById('chat-messages')!;

    input.value = 'add a task';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));

    // Wait for the confirm dialog to open.
    await vi.waitFor(() => expect(overlay.classList.contains('hidden')).toBe(false));

    sendButton.click(); // click Stop while the dialog is open

    await vi.waitFor(() => {
      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(chat.querySelectorAll('.message-stopped').length).toBe(1);
    });
    // The rejected task was never added — the confirm was auto-rejected by
    // the Stop. (The demo seeds three initial tasks; assert the new title is
    // absent rather than asserting an empty list.)
    const titles = Array.from(
      document.getElementById('task-list')!.querySelectorAll('.task-title'),
    ).map((el) => el.textContent ?? '');
    expect(titles).not.toContain('X');
  });
});

describe('multi-action confirmation', () => {
  beforeAll(async () => {
    vi.resetModules();
    localStorage.setItem(
      'forgewisp.demo.config',
      JSON.stringify({ endpoint: 'https://llm.example/v1/chat', model: 'gpt-4o', apiKey: 'k' }),
    );
    document.body.innerHTML = DEMO_BODY;

    // First request returns two addTask tool calls in one assistant turn; every
    // subsequent request (after the tools run) returns a plain final reply so
    // the tool loop terminates.
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          sseToolCallsResponse([
            { name: 'addTask', arguments: JSON.stringify({ title: 'Alpha' }) },
            { name: 'addTask', arguments: JSON.stringify({ title: 'Beta' }) },
          ]),
        );
      }
      return Promise.resolve(sseResponse('done'));
    });
    globalThis.fetch = fetchMock;

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('confirms and runs every action when the model requests several at once', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const overlay = document.getElementById('confirm-overlay') as HTMLDivElement;
    const accept = document.getElementById('confirm-accept') as HTMLButtonElement;
    const taskList = document.getElementById('task-list') as HTMLUListElement;

    input.value = 'add two tasks';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));

    // First confirmation dialog (addTask Alpha). The old single-slot dialog
    // would already have auto-rejected this when the second request arrived.
    await vi.waitFor(() => expect(overlay.classList.contains('hidden')).toBe(false));
    expect(document.getElementById('confirm-description')?.textContent).toContain('addTask');
    accept.click();

    // Second confirmation dialog (addTask Beta) is shown after the first is
    // answered — the queue drains one prompt at a time.
    await vi.waitFor(() => expect(overlay.classList.contains('hidden')).toBe(false));
    accept.click();

    // Both handlers ran — neither was silently auto-rejected.
    await vi.waitFor(() => {
      const titles = Array.from(taskList.querySelectorAll('.task-title')).map(
        (el) => el.textContent ?? '',
      );
      expect(titles).toContain('Alpha');
      expect(titles).toContain('Beta');
    });
  });
});
