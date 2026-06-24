import { describe, it, expect, beforeAll, vi, afterAll, afterEach } from 'vitest';

// Builds a non-streaming-style SSE Response whose `content` deltas concatenate
// to `text`. Both the parent and subagent agents are configured with streaming,
// so every fetch must return an SSE stream (not JSON) for the run to complete.
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

// Loads the full subagent-demo body so main.ts's getEl() lookups succeed at import.
const DEMO_BODY = `
  <div class="app">
    <aside class="sidebar">
      <div id="tools-list"></div>
      <ul id="artifacts-list" aria-label="Subagent runs"></ul>
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
      <div id="example-prompts" class="example-prompts" aria-label="Example prompts"></div>
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

const CONFIG_KEY = 'forgewisp.subagent-demo.config';
const VALID_CONFIG = { endpoint: 'https://llm.example/v1/chat', model: 'gpt-4o', apiKey: 'k' };

afterEach(() => {
  localStorage.removeItem(CONFIG_KEY);
});

describe('submit race guard', () => {
  beforeAll(async () => {
    vi.resetModules();
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

describe('spawnSubagent delegates to a subagent and returns its trimmed answer', () => {
  beforeAll(async () => {
    vi.resetModules();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(VALID_CONFIG));
    document.body.innerHTML = DEMO_BODY;

    // Call counter drives the multi-step flow:
    //   1: parent emits a spawnSubagent tool call.
    //   2: subagent emits a getCurrentTime tool call (the subagent's own loop).
    //   3: subagent returns its final text.
    //   4: parent returns its final text, referencing the subagent's answer.
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          sseToolCallsResponse([
            {
              name: 'spawnSubagent',
              arguments: JSON.stringify({
                task: 'Get the current time and hash it.',
                tools: ['getCurrentTime', 'hashText'],
              }),
            },
          ]),
        );
      }
      if (callCount === 2) {
        return Promise.resolve(
          sseToolCallsResponse([{ name: 'getCurrentTime', arguments: JSON.stringify({}) }]),
        );
      }
      if (callCount === 3) {
        return Promise.resolve(sseResponse('Time is now and hash is h.'));
      }
      return Promise.resolve(sseResponse('Delegated: Time is now and hash is h.'));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await import('../src/main.js');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('runs the subagent loop and surfaces its answer in the parent chat', async () => {
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const overlay = document.getElementById('confirm-overlay') as HTMLDivElement;
    const artifacts = document.getElementById('artifacts-list') as HTMLUListElement;
    const auditLog = document.getElementById('audit-log') as HTMLUListElement;

    input.value = 'research the time and hash';
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));

    // The parent's final message references the subagent's answer (not the raw
    // tool-call transcript), proving the trimmed result flowed back.
    await vi.waitFor(() => {
      const assistant = document.querySelectorAll('.message-assistant:not(.thinking-indicator)');
      expect(assistant.length).toBe(1);
      expect(assistant[0]!.textContent).toContain('Delegated');
    });

    // The subagent run card transitioned spawning → done with the counts.
    await vi.waitFor(() => {
      const card = artifacts.querySelector('.artifact-subagent');
      expect(card?.querySelector('.status-done')).not.toBeNull();
      expect(card?.textContent).toContain('Time is now and hash is h.');
      expect(card?.textContent).toContain('1 tool call'); // subagent ran getCurrentTime
    });

    // All tools involved are read-tier, so no confirmation ever fired.
    expect(overlay.classList.contains('hidden')).toBe(true);
    const types = Array.from(auditLog.querySelectorAll('.audit-type')).map(
      (el) => el.textContent ?? '',
    );
    expect(types).not.toContain('rejected');
    // The parent requested and executed spawnSubagent.
    const fns = Array.from(auditLog.querySelectorAll('.audit-fn')).map(
      (el) => el.textContent ?? '',
    );
    expect(fns).toContain('spawnSubagent');
  });
});

describe('example prompt chips', () => {
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

  it('clicking a chip fills the input and submits the prompt', async () => {
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const chat = document.getElementById('chat-messages');
    const chips = document.querySelectorAll<HTMLButtonElement>('#example-prompts .example-prompt');

    expect(chips.length).toBeGreaterThan(0);
    const prompt = chips[0]!.textContent ?? '';
    expect(prompt.length).toBeGreaterThan(0);

    chips[0]!.click();

    await vi.waitFor(() => {
      expect(recordedBodies.length).toBeGreaterThanOrEqual(1);
    });

    const last = recordedBodies[recordedBodies.length - 1]!.messages;
    expect(last[last.length - 1]).toEqual({ role: 'user', content: prompt });
    expect(chat!.querySelector('.message-user')?.textContent).toBe(prompt);
    expect(input.value).toBe('');
  });

  it('disables chips while a run is in flight', async () => {
    vi.resetModules();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(VALID_CONFIG));
    document.body.innerHTML = DEMO_BODY;

    // Never-resolving fetch so the run stays in flight.
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {})) as typeof fetch;
    await import('../src/main.js');

    const chips = document.querySelectorAll<HTMLButtonElement>('#example-prompts .example-prompt');
    chips[0]!.click();

    // Let the submit handler run (it disables input + chips).
    await Promise.resolve();

    expect(chips[0]!.disabled).toBe(true);
    vi.restoreAllMocks();
  });
});
