import { createAgent } from '@forgewisp/core';
import type {
  AgentResult,
  AuditEvent,
  ChatMessage,
  FunctionDefinition,
  PendingCall,
  ForgewispConfig,
  RiskTier,
} from '@forgewisp/core';
import { createMcpTools } from '@forgewisp/mcp';
import type { McpServerConfig, McpToolsResult } from '@forgewisp/mcp';
import {
  renderArgsHtml,
  renderAuditDetail,
  renderMarkdown,
  renderToolsList,
  escapeHtml,
} from './render.js';
import {
  LocalStorageOAuthProvider,
  storePendingServer,
  readPendingServer,
  clearPendingServer,
} from './oauth.js';

// ─── Sanitization note ────────────────────────────────────────────────────────
// Every sink that turns model- or user-adjacent text into HTML goes through
// DOMPurify (via the helpers in render.ts). The model can return arbitrary
// markdown (including raw HTML); without sanitization,
// `<img src=x onerror=…>` would execute in the page. Server/tool names come
// from the remote MCP server, so they are treated as untrusted too.

// ─── Cached DOM refs ──────────────────────────────────────────────────────────

interface Elements {
  mcpForm: HTMLFormElement;
  mcpName: HTMLInputElement;
  mcpUrl: HTMLInputElement;
  mcpApikey: HTMLInputElement;
  mcpOAuth: HTMLInputElement;
  mcpTier: HTMLSelectElement;
  mcpTimeout: HTMLInputElement;
  mcpStatus: HTMLParagraphElement;
  mcpServersList: HTMLUListElement;
  toolsList: HTMLDivElement;
  chatMessages: HTMLDivElement;
  chatForm: HTMLFormElement;
  chatInput: HTMLInputElement;
  sendButton: HTMLButtonElement;
  reasoningSection: HTMLElement;
  reasoningOutput: HTMLDivElement;
  auditLog: HTMLUListElement;
  clearAuditBtn: HTMLButtonElement;
  configOverlay: HTMLDivElement;
  configForm: HTMLFormElement;
  configEndpoint: HTMLInputElement;
  configModel: HTMLInputElement;
  configApikey: HTMLInputElement;
  confirmOverlay: HTMLDivElement;
  confirmTitle: HTMLHeadingElement;
  confirmDescription: HTMLParagraphElement;
  confirmArgs: HTMLDivElement;
  confirmAccept: HTMLButtonElement;
  confirmReject: HTMLButtonElement;
}

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[mcp-demo] Missing element #${id}`);
  return el as T;
}

const els: Elements = {
  mcpForm: getEl<HTMLFormElement>('mcp-form'),
  mcpName: getEl<HTMLInputElement>('mcp-name'),
  mcpUrl: getEl<HTMLInputElement>('mcp-url'),
  mcpApikey: getEl<HTMLInputElement>('mcp-apikey'),
  mcpOAuth: getEl<HTMLInputElement>('mcp-oauth'),
  mcpTier: getEl<HTMLSelectElement>('mcp-tier'),
  mcpTimeout: getEl<HTMLInputElement>('mcp-timeout'),
  mcpStatus: getEl<HTMLParagraphElement>('mcp-status'),
  mcpServersList: getEl<HTMLUListElement>('mcp-servers-list'),
  toolsList: getEl<HTMLDivElement>('tools-list'),
  chatMessages: getEl<HTMLDivElement>('chat-messages'),
  chatForm: getEl<HTMLFormElement>('chat-form'),
  chatInput: getEl<HTMLInputElement>('chat-input'),
  sendButton: getEl<HTMLFormElement>('chat-form').querySelector(
    'button[type="submit"]',
  ) as HTMLButtonElement,
  reasoningSection: getEl<HTMLElement>('reasoning-section'),
  reasoningOutput: getEl<HTMLDivElement>('reasoning-output'),
  auditLog: getEl<HTMLUListElement>('audit-log'),
  clearAuditBtn: getEl<HTMLButtonElement>('clear-audit-btn'),
  configOverlay: getEl<HTMLDivElement>('config-overlay'),
  configForm: getEl<HTMLFormElement>('config-form'),
  configEndpoint: getEl<HTMLInputElement>('config-endpoint'),
  configModel: getEl<HTMLInputElement>('config-model'),
  configApikey: getEl<HTMLInputElement>('config-apikey'),
  confirmOverlay: getEl<HTMLDivElement>('confirm-overlay'),
  confirmTitle: getEl<HTMLHeadingElement>('confirm-title'),
  confirmDescription: getEl<HTMLParagraphElement>('confirm-description'),
  confirmArgs: getEl<HTMLDivElement>('confirm-args'),
  confirmAccept: getEl<HTMLButtonElement>('confirm-accept'),
  confirmReject: getEl<HTMLButtonElement>('confirm-reject'),
};

// ─── Streaming output helpers ─────────────────────────────────────────────────

function getOrCreateStreamingMessage(): HTMLDivElement {
  let el = document.getElementById('streaming-message') as HTMLDivElement | null;
  if (!el) {
    // The first text token swaps the "Thinking…" placeholder out for the real
    // streaming bubble.
    removeThinkingPlaceholder();
    el = document.createElement('div');
    el.id = 'streaming-message';
    el.className = 'message message-assistant streaming';
    els.chatMessages.appendChild(el);
  }
  return el;
}

// "Thinking…" placeholder shown in the chat area between submit and the first
// streamed text token. Lives only for the current turn.
let currentTurnThinkingEl: HTMLDivElement | null = null;

function showThinkingPlaceholder(): void {
  removeThinkingPlaceholder();
  const el = document.createElement('div');
  el.className = 'message message-assistant thinking-indicator';
  el.setAttribute('aria-label', 'Thinking');
  el.appendChild(document.createElement('span')).className = 'dot';
  el.appendChild(document.createElement('span')).className = 'dot';
  el.appendChild(document.createElement('span')).className = 'dot';
  els.chatMessages.appendChild(el);
  currentTurnThinkingEl = el;
}

function removeThinkingPlaceholder(): void {
  if (currentTurnThinkingEl) {
    currentTurnThinkingEl.remove();
    currentTurnThinkingEl = null;
  }
}

function finalizeStreamingMessage(): HTMLDivElement | null {
  const el = document.getElementById('streaming-message') as HTMLDivElement | null;
  if (el) {
    // Flush the latest text synchronously so the finalized bubble shows the full answer even if
    // the coalesced rAF render hadn't fired yet (e.g. the run resolved in the same frame as the
    // last chunk). Without this, the bubble could be left empty — the success path skips
    // `appendAssistantMessage` when a streaming element exists.
    const acc = currentTurnStreamingText;
    if (acc) el.innerHTML = renderMarkdown(acc.text);
    el.id = '';
    el.classList.remove('streaming');
  }
  return el;
}

// Coalesce the streaming markdown re-render (marked.parse + DOMPurify over the full accumulated
// text + a full innerHTML replacement) to once per animation frame. Re-rendering on every token
// chunk was O(text.length × chunk.count) — a long streamed answer re-parsed the whole growing
// text once per token. `requestAnimationFrame` is absent in the jsdom test env; the tests assert
// only element presence (the bubble is created eagerly in onTextChunk), and finalize flushes the
// final render synchronously, so they don't depend on the rAF firing.
let streamingRenderPending = false;
function scheduleStreamingRender(): void {
  if (streamingRenderPending) return;
  streamingRenderPending = true;
  requestAnimationFrame(() => {
    streamingRenderPending = false;
    const acc = currentTurnStreamingText;
    if (!acc) return;
    const el = document.getElementById('streaming-message');
    if (el) el.innerHTML = renderMarkdown(acc.text);
  });
}

// ─── Confirmation dialog ──────────────────────────────────────────────────────

// The core executor calls onConfirmRequired once per write/destructive tool
// call, concurrently (Promise.allSettled over every call in a round). The UI
// can only show one modal at a time, so we serialize the prompts with a FIFO
// queue: each enqueued call resolves its own promise when the user answers its
// dialog, then the next queued call is shown. This keeps the core's per-call
// contract intact while ensuring no confirmation is silently auto-rejected.
interface QueuedConfirm {
  pendingCall: PendingCall;
  resolve: (result: boolean) => void;
}

const confirmQueue: QueuedConfirm[] = [];
let activeConfirm: QueuedConfirm | null = null;

function showConfirmDialog(pendingCall: PendingCall): Promise<boolean> {
  return new Promise((resolve) => {
    confirmQueue.push({ pendingCall, resolve });
    processNextConfirm();
  });
}

function processNextConfirm(): void {
  if (activeConfirm) return; // a dialog is already open; it'll drain the queue
  const next = confirmQueue.shift();
  if (!next) return;
  activeConfirm = next;
  renderConfirmDialog(next.pendingCall, (result) => {
    activeConfirm = null;
    next.resolve(result);
    processNextConfirm();
  });
}

function renderConfirmDialog(pendingCall: PendingCall, done: (result: boolean) => void): void {
  els.confirmTitle.textContent =
    pendingCall.riskTier === 'destructive' ? '⚠️ Destructive Action' : 'Action Required';
  els.confirmDescription.textContent = `Function: ${pendingCall.functionName}`;
  // Args came through AJV validation, but escape defensively — never raw.
  els.confirmArgs.innerHTML = renderArgsHtml(pendingCall.args);

  els.confirmOverlay.classList.remove('hidden');
  els.confirmAccept.focus();

  const previouslyFocused = document.activeElement as HTMLElement | null;

  const cleanup = (result: boolean): void => {
    els.confirmOverlay.classList.add('hidden');
    els.confirmAccept.removeEventListener('click', onAccept);
    els.confirmReject.removeEventListener('click', onReject);
    document.removeEventListener('keydown', onKeydown);
    previouslyFocused?.focus?.();
    done(result);
  };
  const onAccept = (): void => cleanup(true);
  const onReject = (): void => cleanup(false);
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup(false);
    }
    const target = e.target as Element | null;
    if (e.key === 'Enter' && !(target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      cleanup(true);
    }
  };
  els.confirmAccept.addEventListener('click', onAccept);
  els.confirmReject.addEventListener('click', onReject);
  document.addEventListener('keydown', onKeydown);
}

// ─── Audit log ───────────────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  function_requested: 'requested',
  validation_passed: 'validation passed',
  validation_failed: 'validation failed',
  confirmation_requested: 'confirm?',
  confirmation_accepted: 'confirmed',
  confirmation_rejected: 'rejected',
  function_executed: 'executed',
  function_errored: 'errored',
  audit_callback_errored: 'audit callback errored',
  max_tool_rounds_reached: 'max rounds',
  stream_malformed: 'stream malformed',
};

// Cap the DOM audit list. Core's AuditLog is ring-bounded to 1000, but this UI list was never
// trimmed and grew for the whole session; drop the oldest (trailing) entries beyond the cap.
const MAX_AUDIT_ENTRIES = 500;

function appendAuditEntry(event: AuditEvent): void {
  const li = document.createElement('li');
  li.className = `audit-event audit-${event.type.replace(/_/g, '-')}`;
  const label = EVENT_LABELS[event.type] ?? event.type;
  li.innerHTML =
    `<span class="audit-fn">${escapeHtml(event.functionName)}</span>` +
    `<span class="audit-type">${escapeHtml(label)}</span>` +
    `<span class="audit-detail">${renderAuditDetail(event)}</span>`;
  els.auditLog.prepend(li);
  while (els.auditLog.childElementCount > MAX_AUDIT_ENTRIES) {
    els.auditLog.lastElementChild?.remove();
  }
}

function onAuditEvent(event: AuditEvent): void {
  appendAuditEntry(event);
}

function clearAuditUI(): void {
  els.auditLog.innerHTML = '';
}

els.clearAuditBtn.addEventListener('click', () => {
  if (!agent) return;
  agent.clearAuditLog();
  clearAuditUI();
});

// ─── Chat UI ──────────────────────────────────────────────────────────────────

function appendUserMessage(text: string): void {
  const el = document.createElement('div');
  el.className = 'message message-user';
  el.textContent = text;
  els.chatMessages.appendChild(el);
}

function appendAssistantMessage(text: string): void {
  const el = document.createElement('div');
  el.className = 'message message-assistant';
  el.innerHTML = renderMarkdown(text);
  els.chatMessages.appendChild(el);
}

// ─── Agent setup ──────────────────────────────────────────────────────────────

type Agent = ReturnType<typeof createAgent>;
let agent: Agent | null = null;
let inFlightController: AbortController | null = null;

// Conversation history threaded back into agent.run so the model sees prior
// user/assistant turns. Cleared whenever the agent is rebuilt (new config).
const conversation: ChatMessage[] = [];

interface AgentConfig {
  endpoint: string;
  apiKey: string;
  model: string;
}

function buildAgent(cfg: AgentConfig): void {
  // Abort any in-flight run from the previous agent before swapping it out.
  if (inFlightController) {
    inFlightController.abort();
    inFlightController = null;
  }

  // A new agent means a fresh conversation — don't leak prior turns (which may
  // have been produced by a different model/endpoint) into the new session.
  // Also drop any MCP servers from the previous agent (their tools are
  // registered on the old agent instance).
  conversation.length = 0;
  // Drop prior servers SYNCHRONOUSLY (deregister from the old agent + clear the registries now),
  // then close their network sessions in the background. Doing this async (the old
  // `void disconnectAllServers()` awaited `server.close()` per server) raced a same-name
  // reconnect: the new connect's `mcpServers.has(cfg.name)` guard fired before the async cleanup
  // had removed the old entry, rejecting the reconnect as a duplicate.
  abandonAllServersSync();

  const config: ForgewispConfig = {
    llmEndpoint: cfg.endpoint,
    apiKey: cfg.apiKey || undefined,
    model: cfg.model,
    systemPrompt:
      'You are an assistant whose toolkit is supplied entirely by connected MCP servers. ' +
      'Use the available tools to answer the user. Always explain briefly what you are about ' +
      'to do before calling a write or destructive tool, and prefer the least-invasive tool. ' +
      'Chain tools when the request needs several steps.',
    onConfirmRequired: showConfirmDialog,
    onAuditEvent,
    streaming: {
      reasoning: { mode: 'native' },
      onTextChunk: (chunk: string) => {
        const acc = currentTurnStreamingText;
        if (acc === null) return;
        acc.text += chunk;
        // Create the streaming bubble immediately; coalesce the markdown re-render to once per
        // frame (see `scheduleStreamingRender`) instead of once per token.
        getOrCreateStreamingMessage();
        scheduleStreamingRender();
      },
      onReasoningChunk: (chunk: string) => {
        els.reasoningSection.classList.remove('hidden');
        els.reasoningOutput.textContent += chunk;
      },
    },
  };

  agent = createAgent(config);
}

interface TurnStreamingState {
  text: string;
}
let currentTurnStreamingText: TurnStreamingState | null = null;

// ─── MCP server registry ─────────────────────────────────────────────────────

interface ConnectedServer {
  name: string;
  tools: FunctionDefinition[];
  authState: 'authorized' | 'pending';
  finishAuth?: (authorizationCode: string) => Promise<void>;
  /** Present for OAuth servers, so disconnect can clear persisted tokens. */
  provider?: LocalStorageOAuthProvider;
  close: () => Promise<void>;
}

// Keyed by configured server name. The demo always sets `hasConfirmation: true`
// (the agent wires `onConfirmRequired`), so the @forgewisp/mcp confirmation
// preflight never trips; core's own registration-time invariant remains the
// backstop for write/destructive tools.
const mcpServers = new Map<string, ConnectedServer>();

// OAuth servers mid-authorization, keyed by the OAuth `state` the SDK put in the authorization
// URL. The callback page posts `{ code, state }` back; we look the server up by `state` and call its
// `finishAuth(code)`. A server is in this map only between the (pending) connect and the
// redirect-back (or a disconnect).
interface PendingAuth {
  serverName: string;
  result: McpToolsResult;
  provider: LocalStorageOAuthProvider;
}
const pendingByState = new Map<string, PendingAuth>();

function setMcpStatus(message: string, kind: 'ok' | 'error' | '' = ''): void {
  els.mcpStatus.textContent = message;
  els.mcpStatus.classList.remove('ok', 'error');
  if (kind) els.mcpStatus.classList.add(kind);
}

interface McpFormConfig {
  name: string;
  url: string;
  apiKey: string;
  useOAuth: boolean;
  scope?: string;
  defaultTier: RiskTier;
  requestTimeoutMs?: number;
}

/** Build the `McpServerConfig` from a form config (OAuth provider when `useOAuth`, else apiKey). */
function buildServerConfig(cfg: McpFormConfig): {
  config: McpServerConfig;
  provider?: LocalStorageOAuthProvider;
} {
  const provider = cfg.useOAuth ? new LocalStorageOAuthProvider(cfg.name, cfg.scope) : undefined;
  const config: McpServerConfig = {
    name: cfg.name,
    url: cfg.url,
    defaultTier: cfg.defaultTier,
    hasConfirmation: true,
  };
  if (provider) {
    config.authProvider = provider;
  } else {
    config.apiKey = cfg.apiKey || undefined;
  }
  if (cfg.requestTimeoutMs !== undefined) config.requestTimeoutMs = cfg.requestTimeoutMs;
  return { config, provider };
}

/** Register `tools` on the live agent, rolling back on a partial registration failure. Returns
 *  `true` on success. */
function registerToolsOnAgent(name: string, tools: FunctionDefinition[]): boolean {
  if (!agent) return false;
  try {
    for (const def of tools) agent.registerFunction(def);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const def of tools) agent.deregisterFunction(def.name);
    setMcpStatus(`Registration failed for "${name}": ${msg}`, 'error');
    return false;
  }
  return true;
}

function finalizeConnectedServer(
  name: string,
  result: McpToolsResult,
  provider: LocalStorageOAuthProvider | undefined,
): void {
  mcpServers.set(name, {
    name,
    tools: result.tools,
    authState: result.authState,
    finishAuth: result.finishAuth,
    provider,
    close: result.close,
  });
  renderConnectedTools();
  renderServerChips();
}

async function connectMcpServerCfg(cfg: McpFormConfig): Promise<void> {
  if (!agent) {
    setMcpStatus('Connect an LLM first.', 'error');
    return;
  }
  if (mcpServers.has(cfg.name) || isPendingName(cfg.name)) {
    setMcpStatus(`Server "${cfg.name}" is already connected or authorizing.`, 'error');
    return;
  }

  setMcpStatus(`Connecting to ${cfg.url}…`);
  const { config, provider } = buildServerConfig(cfg);

  let result: McpToolsResult;
  try {
    result = await createMcpTools(config);
  } catch (err) {
    // createMcpTools already opened a client before the failure could occur in list/adapt; nothing
    // to close here (the SDK throws before returning on connect failure). Surface the error and
    // leave the registry untouched.
    const msg = err instanceof Error ? err.message : String(err);
    setMcpStatus(`Connect failed: ${msg}`, 'error');
    return;
  }

  if (result.authState === 'pending') {
    // OAuth: the SDK redirected the user agent (popup, or a blocked-popup fallback URL). Track the
    // pending server by the OAuth `state` so the callback's `message` can finish it. Keep the
    // (empty-tools) server in the registry so the UI shows it as "authorizing".
    const state = provider?.getPendingState();
    if (provider && state) {
      pendingByState.set(state, { serverName: cfg.name, result, provider });
      // Same-tab fallback: persist the config so the load-resume path can complete if the user
      // navigates away (popup blocked → manual link → return).
      storePendingServer(state, {
        name: cfg.name,
        url: cfg.url,
        defaultTier: cfg.defaultTier,
        hasConfirmation: true,
        requestTimeoutMs: cfg.requestTimeoutMs,
        scope: cfg.scope,
      });
    }
    const blockedUrl = provider?.getBlockedAuthUrl();
    setMcpStatus(
      blockedUrl
        ? `Popup blocked for "${cfg.name}". Click here to authorize: ${blockedUrl.toString()}`
        : `Authorizing "${cfg.name}" — complete the sign-in in the popup window.`,
      blockedUrl ? 'error' : '',
    );
    finalizeConnectedServer(cfg.name, result, provider);
    return;
  }

  // Authorized: register the tools on the live agent.
  if (!registerToolsOnAgent(cfg.name, result.tools)) {
    await result.close();
    return;
  }
  finalizeConnectedServer(cfg.name, result, provider);
  setMcpStatus(
    `Connected "${cfg.name}" (${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}).`,
    'ok',
  );
}

/**
 * A pending OAuth flow failed (the user denied consent, or the authorization server returned an
 * `error`). Clear the pending server and surface the failure so the UI doesn't stay stuck on
 * "Authorizing …". Handles both the popup path (a live handle in `pendingByState`) and the
 * same-tab reload path (no in-memory handle — best-effort via the persisted pending config).
 */
async function failPendingOAuth(state: string, error: string, description?: string): Promise<void> {
  const message = description ? `${error} — ${description}` : error;
  const pendingCfg = readPendingServer(state);
  clearPendingServer(state);
  const pending = pendingByState.get(state);
  if (pending) {
    pendingByState.delete(state);
    const { serverName, result } = pending;
    await result.close().catch(() => {
      /* ignore */
    });
    mcpServers.delete(serverName);
    renderConnectedTools();
    renderServerChips();
    setMcpStatus(`Authorization failed for "${serverName}": ${message}`, 'error');
    return;
  }
  // Page reloaded mid-flow (same-tab fallback) — no in-memory handle to close. Surface via the
  // persisted server name if we have it.
  const name = pendingCfg?.name;
  setMcpStatus(`Authorization failed${name ? ` for "${name}"` : ''}: ${message}`, 'error');
}

/** Complete a pending OAuth flow: exchange `code`, register the now-listed tools, and update UI. */
async function finishPendingOAuth(state: string, code: string): Promise<void> {
  const pending = pendingByState.get(state);
  if (!pending) return; // not ours (e.g. stale message) — ignore
  pendingByState.delete(state);
  clearPendingServer(state);

  const { serverName, result, provider } = pending;
  setMcpStatus(`Finishing sign-in for "${serverName}"…`);
  try {
    await result.finishAuth(code);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setMcpStatus(`Authorization failed for "${serverName}": ${msg}`, 'error');
    await result.close();
    mcpServers.delete(serverName);
    renderConnectedTools();
    renderServerChips();
    return;
  }

  // finishAuth populated `result.tools` in place and set `authState` to 'authorized'.
  if (!registerToolsOnAgent(serverName, result.tools)) {
    await result.close();
    mcpServers.delete(serverName);
    renderConnectedTools();
    renderServerChips();
    return;
  }
  finalizeConnectedServer(serverName, result, provider);
  setMcpStatus(
    `Connected "${serverName}" (${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}).`,
    'ok',
  );
}

function isPendingName(name: string): boolean {
  for (const p of pendingByState.values()) if (p.serverName === name) return true;
  return false;
}

async function disconnectServer(name: string): Promise<void> {
  // Drop any pending OAuth state for this server (the user gave up before the redirect-back).
  for (const [state, p] of pendingByState) {
    if (p.serverName === name) {
      pendingByState.delete(state);
      clearPendingServer(state);
      await p.result.close().catch(() => {
        /* ignore */
      });
    }
  }
  const server = mcpServers.get(name);
  if (!server) return;
  if (agent) {
    for (const def of server.tools) agent.deregisterFunction(def.name);
  }
  await server.close();
  // For OAuth servers, clear persisted tokens so a reconnect re-runs the flow rather than reusing
  // stale credentials the user explicitly abandoned.
  if (server.provider) LocalStorageOAuthProvider.clear(name);
  mcpServers.delete(name);
  setMcpStatus(`Disconnected "${name}".`, 'ok');
  renderConnectedTools();
  renderServerChips();
}

/**
 * Drop every connected/pending server from the CURRENT agent and the in-memory registries
 * synchronously, closing their network sessions in the background. Used on agent rebuild so a
 * same-name reconnect isn't blocked by a not-yet-removed entry (the per-server `disconnectServer`
 * awaits `server.close()` and would race the reconnect's `mcpServers.has(name)` guard). The old
 * agent is being replaced regardless, so its tool registrations are dropped now and the closable
 * sessions are torn down without blocking the rebuild.
 */
function abandonAllServersSync(): void {
  const servers = Array.from(mcpServers.values());
  mcpServers.clear();
  for (const [state, p] of pendingByState) {
    clearPendingServer(state);
    void p.result.close().catch(() => {
      /* ignore */
    });
  }
  pendingByState.clear();
  for (const s of servers) {
    if (agent) for (const def of s.tools) agent.deregisterFunction(def.name);
    // OAuth servers: drop persisted tokens so a reconnect re-runs the flow rather than reusing
    // credentials the user is abandoning by rebuilding.
    if (s.provider) LocalStorageOAuthProvider.clear(s.name);
    void s.close().catch(() => {
      /* ignore */
    });
  }
  renderConnectedTools();
  renderServerChips();
}

// ─── OAuth redirect-back (popup) ──────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  // Only accept messages from our own origin (the callback page is served on the same origin) and
  // only our typed payload — ignores any unrelated postMessage traffic on the page.
  if (event.origin !== location.origin) return;
  const data = event.data as {
    type?: string;
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
  } | null;
  if (!data || data.type !== 'forgewisp-mcp-oauth') return;
  // Failure redirect from the authorization server — clear the pending server and surface the error
  // (without this the popup would just display the error while the main UI stayed "Authorizing …").
  if (data.error && data.state) {
    void failPendingOAuth(data.state, data.error, data.errorDescription);
    return;
  }
  if (!data.code || !data.state) return;
  void finishPendingOAuth(data.state, data.code);
});

// ─── OAuth resume (same-tab fallback, after a page reload) ───────────────────

/** If the page loaded with `?code&state` (same-tab OAuth fallback returned here), finish the flow in
 *  one shot via `createMcpTools(config, { authorizationCode })`. Also handles `?error&state` (a failed
 *  same-tab authorization) by clearing the pending server and surfacing the error. The error path
 *  needs no agent (it only tears down pending state), so it runs before the agent guard. */
async function resumeOAuthFromUrl(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  const code = params.get('code');
  const state = params.get('state');
  // A failed same-tab authorization: clear the pending server and surface the error. No agent is
  // needed (this only tears down pending state), so handle it before the `!agent` guard below.
  if (error && state) {
    history.replaceState({}, '', location.pathname);
    await failPendingOAuth(state, error, params.get('error_description') ?? undefined);
    return;
  }
  if (!code || !state) return;
  if (!agent) return; // No LLM configured yet — the resume can't register; leave the params for later.
  const pendingCfg = readPendingServer(state);
  if (!pendingCfg) return; // Unknown state — nothing to resume.

  // Clean the URL first so a refresh doesn't replay the code (which is single-use).
  history.replaceState({}, '', location.pathname);

  setMcpStatus(`Finishing sign-in for "${pendingCfg.name}"…`);
  const provider = new LocalStorageOAuthProvider(pendingCfg.name, pendingCfg.scope);
  const config: McpServerConfig = {
    name: pendingCfg.name,
    url: pendingCfg.url,
    authProvider: provider,
    defaultTier: pendingCfg.defaultTier,
    hasConfirmation: pendingCfg.hasConfirmation,
  };
  if (pendingCfg.requestTimeoutMs !== undefined)
    config.requestTimeoutMs = pendingCfg.requestTimeoutMs;

  let result: McpToolsResult;
  try {
    result = await createMcpTools(config, { authorizationCode: code });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setMcpStatus(`Authorization failed for "${pendingCfg.name}": ${msg}`, 'error');
    clearPendingServer(state);
    return;
  }
  clearPendingServer(state);

  if (result.authState !== 'authorized' || !registerToolsOnAgent(pendingCfg.name, result.tools)) {
    await result.close();
    setMcpStatus(`Authorization failed for "${pendingCfg.name}".`, 'error');
    return;
  }
  finalizeConnectedServer(pendingCfg.name, result, provider);
  setMcpStatus(
    `Connected "${pendingCfg.name}" (${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}).`,
    'ok',
  );
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

function renderConnectedTools(): void {
  const all: FunctionDefinition[] = [];
  for (const server of mcpServers.values()) {
    for (const tool of server.tools) all.push(tool);
  }
  els.toolsList.innerHTML = renderToolsList(all);
}

// Build the connected-server chips with the DOM API (not innerHTML) so a
// server/tool name can never break out of an attribute or text node.
function renderServerChips(): void {
  els.mcpServersList.innerHTML = '';
  for (const server of mcpServers.values()) {
    const li = document.createElement('li');
    li.className = 'mcp-server-chip';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'mcp-server-name';
    nameSpan.textContent = server.name;
    li.appendChild(nameSpan);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Disconnect';
    btn.addEventListener('click', () => void disconnectServer(server.name));
    li.appendChild(btn);

    els.mcpServersList.appendChild(li);
  }
}

// ─── MCP form ─────────────────────────────────────────────────────────────────

els.mcpForm.addEventListener('submit', (e: SubmitEvent) => {
  e.preventDefault();
  const name = els.mcpName.value.trim();
  const url = els.mcpUrl.value.trim();
  if (!name || !url) {
    setMcpStatus('Name and URL are required.', 'error');
    return;
  }
  const cfg: McpFormConfig = {
    name,
    url,
    apiKey: els.mcpApikey.value.trim(),
    useOAuth: els.mcpOAuth.checked,
    defaultTier: els.mcpTier.value as RiskTier,
  };
  const timeoutRaw = els.mcpTimeout.value.trim();
  if (timeoutRaw !== '') {
    const parsed = Number(timeoutRaw);
    if (Number.isFinite(parsed) && parsed > 0) cfg.requestTimeoutMs = parsed;
  }
  // Clear the form on submit; status reflects connect outcome.
  els.mcpForm.reset();
  els.mcpTier.value = 'read';
  void connectMcpServerCfg(cfg);
});

// ─── Config overlay ───────────────────────────────────────────────────────────

function showConfigForm(): void {
  els.configOverlay.classList.remove('hidden');
  els.configEndpoint.focus();
}

function hideConfigForm(): void {
  els.configOverlay.classList.add('hidden');
}

// ─── Chat form ────────────────────────────────────────────────────────────────

function setFormDisabled(disabled: boolean): void {
  els.chatInput.disabled = disabled;
  els.sendButton.disabled = disabled;
}

async function handleChatSubmit(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text || !agent) return;
  if (inFlightController) return; // race guard — already a run in flight

  appendUserMessage(text);
  els.chatInput.value = '';
  setFormDisabled(true);
  showThinkingPlaceholder();

  // Per-turn streaming buffer. Module-level so the buildAgent-bound streaming callbacks can reach
  // it; the `inFlightController` race guard + the `finally` reset make concurrent turns impossible
  // and rebuilds don't inherit stale state.
  currentTurnStreamingText = { text: '' };
  streamingRenderPending = false;
  els.reasoningOutput.textContent = '';
  els.reasoningSection.classList.add('hidden');

  const controller = new AbortController();
  inFlightController = controller;

  try {
    // `history` is the prior turns only — the current `text` is passed as the
    // userMessage arg. We append both turns to `conversation` only after the
    // run succeeds, so a failed/aborted exchange never pollutes future history.
    const result: AgentResult = await agent.run(text, {
      signal: controller.signal,
      history: conversation,
    });
    const streamingEl = finalizeStreamingMessage();
    if (result.response) {
      conversation.push({ role: 'user', content: text });
      conversation.push({ role: 'assistant', content: result.response });
    }
    // If the response was already rendered via streaming chunks, don't duplicate it.
    if (result.response && !streamingEl) {
      appendAssistantMessage(result.response);
    }
  } catch (err) {
    finalizeStreamingMessage();
    const msg = err instanceof Error ? err.message : String(err);
    appendAssistantMessage(`[error] ${msg}`);
  } finally {
    inFlightController = null;
    currentTurnStreamingText = null;
    removeThinkingPlaceholder();
    setFormDisabled(false);
    els.chatInput.focus();
  }
}

els.chatForm.addEventListener('submit', (e: SubmitEvent) => void handleChatSubmit(e));

// ─── Config form handler ──────────────────────────────────────────────────────

els.configForm.addEventListener('submit', (e: SubmitEvent) => {
  e.preventDefault();
  const cfg: AgentConfig = {
    endpoint: els.configEndpoint.value.trim(),
    model: els.configModel.value.trim(),
    apiKey: els.configApikey.value.trim(),
  };
  if (!cfg.endpoint || !cfg.model) return;
  localStorage.setItem('forgewisp.mcp-demo.config', JSON.stringify(cfg));
  buildAgent(cfg);
  hideConfigForm();
  // If the page loaded with a pending OAuth `?code&state` but no LLM was configured, finish the
  // resume now that an agent exists.
  void resumeOAuthFromUrl();
});

// ─── Safe localStorage config ─────────────────────────────────────────────────

function isAgentConfig(v: unknown): v is AgentConfig {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.endpoint === 'string' &&
    typeof o.model === 'string' &&
    (o.apiKey === undefined || typeof o.apiKey === 'string')
  );
}

function loadStoredConfig(): AgentConfig | null {
  const stored = localStorage.getItem('forgewisp.mcp-demo.config');
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isAgentConfig(parsed)) {
    // Corrupt or shape-mismatched — clear it so the user gets a clean form.
    localStorage.removeItem('forgewisp.mcp-demo.config');
    return null;
  }
  return parsed;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

renderConnectedTools();
renderServerChips();

const stored = loadStoredConfig();
if (stored) {
  buildAgent(stored);
  // If the page reloaded mid-OAuth (same-tab fallback returned with ?code&state), finish the flow
  // now that an agent exists to register the tools on. Non-OAuth boots have no params → no-op.
  void resumeOAuthFromUrl();
} else {
  showConfigForm();
  // No LLM configured yet — the resume can't register tools. Leave `?code&state` in the URL so the
  // resume runs after the user configures an LLM (buildAgent → resumeOAuthFromUrl below).
}
