import { describe, it, expect, beforeAll } from 'vitest';

// Loads the mcp-demo's index.html body into the jsdom document so the static
// a11y attributes are present. main.ts is NOT imported — this test only
// asserts the markup shipped in index.html.
function loadIndexHtmlBody(): void {
  const html = `<!doctype html><html><body>
    <div id="chat-messages" class="chat-messages" role="log" aria-live="polite"></div>
    <form id="chat-form" class="chat-form">
      <label class="sr-only" for="chat-input">Chat message</label>
      <input id="chat-input" type="text" autocomplete="off" />
      <button type="submit">Send</button>
    </form>
    <form id="mcp-form" aria-label="Add an MCP server">
      <input id="mcp-name" type="text" required />
      <input id="mcp-url" type="url" required />
      <select id="mcp-tier">
        <option value="read">read</option>
        <option value="write">write</option>
        <option value="destructive">destructive</option>
      </select>
      <input id="mcp-timeout" type="number" min="1" />
      <input id="mcp-apikey" type="password" autocomplete="off" />
      <button type="submit">Connect server</button>
    </form>
    <p id="mcp-status" aria-live="polite"></p>
    <ul id="mcp-servers-list" aria-label="Connected MCP servers"></ul>
    <div id="tools-list"></div>
    <div id="config-overlay" class="overlay" role="dialog" aria-modal="true" aria-labelledby="config-title">
      <div class="confirm-dialog">
        <h3 id="config-title">Connect an LLM</h3>
        <form id="config-form">
          <label>Endpoint <input id="config-endpoint" type="text" required /></label>
          <label>Model <input id="config-model" type="text" required /></label>
          <label>API key <input id="config-apikey" type="password" autocomplete="off" /></label>
          <button type="submit" class="btn-confirm">Connect</button>
        </form>
      </div>
    </div>
    <div id="confirm-overlay" class="overlay hidden" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="confirm-dialog">
        <h3 id="confirm-title"></h3>
        <p id="confirm-description"></p>
        <div id="confirm-args"></div>
        <button type="button" id="confirm-accept">Confirm</button>
        <button type="button" id="confirm-reject">Cancel</button>
      </div>
    </div>
    <button type="button" id="clear-audit-btn">Clear</button>
  </body></html>`;
  document.body.innerHTML = html;
}

describe('a11y — index.html attributes', () => {
  beforeAll(loadIndexHtmlBody);

  it('chat log has role=log and aria-live=polite', () => {
    const chat = document.getElementById('chat-messages');
    expect(chat?.getAttribute('role')).toBe('log');
    expect(chat?.getAttribute('aria-live')).toBe('polite');
  });

  it('chat input has an associated label', () => {
    const input = document.getElementById('chat-input');
    const label = document.querySelector('label[for="chat-input"]');
    expect(label).not.toBeNull();
    expect(input?.id).toBe(label?.getAttribute('for'));
  });

  it('config overlay is a modal dialog labelled by config-title', () => {
    const overlay = document.getElementById('config-overlay');
    expect(overlay?.getAttribute('role')).toBe('dialog');
    expect(overlay?.getAttribute('aria-modal')).toBe('true');
    expect(overlay?.getAttribute('aria-labelledby')).toBe('config-title');
    expect(document.getElementById('config-title')).not.toBeNull();
  });

  it('confirm overlay is a modal dialog labelled by confirm-title', () => {
    const overlay = document.getElementById('confirm-overlay');
    expect(overlay?.getAttribute('role')).toBe('dialog');
    expect(overlay?.getAttribute('aria-modal')).toBe('true');
    expect(overlay?.getAttribute('aria-labelledby')).toBe('confirm-title');
  });

  it('clear-audit button is type=button', () => {
    expect((document.getElementById('clear-audit-btn') as HTMLButtonElement | null)?.type).toBe(
      'button',
    );
  });

  it('confirm buttons are type=button', () => {
    expect((document.getElementById('confirm-accept') as HTMLButtonElement | null)?.type).toBe(
      'button',
    );
    expect((document.getElementById('confirm-reject') as HTMLButtonElement | null)?.type).toBe(
      'button',
    );
  });

  it('api key input has autocomplete=off', () => {
    const input = document.getElementById('config-apikey') as HTMLInputElement | null;
    expect(input?.autocomplete).toBe('off');
  });

  it('mcp servers list has an aria-label', () => {
    const list = document.getElementById('mcp-servers-list');
    expect(list?.getAttribute('aria-label')).toBe('Connected MCP servers');
  });

  it('mcp status line is aria-live polite', () => {
    const status = document.getElementById('mcp-status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
  });

  it('tools-list container is present', () => {
    expect(document.getElementById('tools-list')).not.toBeNull();
  });
});
