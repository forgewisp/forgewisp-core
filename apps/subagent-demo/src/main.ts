import { createAgent, createSubagentTool, defineToolSet } from '@forgewisp/core';
import type {
  AgentResult,
  AuditEvent,
  ChatMessage,
  PendingCall,
  ForgewispConfig,
} from '@forgewisp/core';
import {
  getCurrentTime,
  generateUuid,
  evaluateMath,
  hashText,
  encodeBase64,
  decodeBase64,
  getViewportInfo,
  getBatteryInfo,
  listLocalStorageKeys,
  getLocalStorageItem,
  downloadFile,
} from '@forgewisp/bundled-tools';
import {
  renderArgsHtml,
  renderArtifact,
  renderAuditDetail,
  renderMarkdown,
  renderToolsList,
  escapeHtml,
} from './render.js';
import type { ToolMeta } from './render.js';
import { SubagentBoard } from './subagent-board.js';

// ─── Sanitization note ────────────────────────────────────────────────────────
// Every sink that turns model- or user-adjacent text into HTML goes through
// DOMPurify (via the helpers in render.ts). The model can return arbitrary
// markdown (including raw HTML); without sanitization,
// `<img src=x onerror=…>` would execute in the page.

// ─── Cached DOM refs ──────────────────────────────────────────────────────────

interface Elements {
  toolsList: HTMLDivElement;
  artifactsList: HTMLUListElement;
  clearArtifactsBtn: HTMLButtonElement;
  chatMessages: HTMLDivElement;
  chatForm: HTMLFormElement;
  chatInput: HTMLInputElement;
  sendButton: HTMLButtonElement;
  examplePrompts: HTMLDivElement;
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
  if (!el) throw new Error(`[subagent-demo] Missing element #${id}`);
  return el as T;
}

const els: Elements = {
  toolsList: getEl<HTMLDivElement>('tools-list'),
  artifactsList: getEl<HTMLUListElement>('artifacts-list'),
  clearArtifactsBtn: getEl<HTMLButtonElement>('clear-artifacts-btn'),
  chatMessages: getEl<HTMLDivElement>('chat-messages'),
  chatForm: getEl<HTMLFormElement>('chat-form'),
  chatInput: getEl<HTMLInputElement>('chat-input'),
  sendButton: getEl<HTMLFormElement>('chat-form').querySelector(
    'button[type="submit"]',
  ) as HTMLButtonElement,
  examplePrompts: getEl<HTMLDivElement>('example-prompts'),
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

// Derived, in-place view of the subagent runs the parent spawns. Fed by audit
// events (see subagent-board.ts); the parent agent owns the authoritative loop.
const board = new SubagentBoard(els.artifactsList);

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
    el.id = '';
    el.classList.remove('streaming');
  }
  return el;
}

// ─── Confirmation dialog ──────────────────────────────────────────────────────

// The core executor calls onConfirmRequired once per write/destructive tool
// call, concurrently (Promise.allSettled over every call in a round). The UI
// can only show one modal at a time, so we serialize the prompts with a FIFO
// queue: each enqueued call resolves its own promise when the user answers its
// dialog, then the next queued call is shown. The same queue serves BOTH the
// parent and any spawned subagents (the subagent reuses showConfirmDialog), so
// a subagent's write-tier calls prompt through the same UI.
interface QueuedConfirm {
  pendingCall: PendingCall;
  resolve: (result: boolean) => void;
}

const confirmQueue: QueuedConfirm[] = [];
let activeConfirm: QueuedConfirm | null = null;
// The active dialog's cleanup callback, captured so an in-flight Stop can
// close the dialog (reject the confirm) without going through its buttons.
let activeConfirmCleanup: ((result: boolean) => void) | null = null;

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
    activeConfirmCleanup = null;
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
  activeConfirmCleanup = cleanup;
}

// ─── Audit log + subagent runs ────────────────────────────────────────────────

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
  run_failed: 'run failed',
  stream_malformed: 'stream malformed',
};

function appendAuditEntry(event: AuditEvent): void {
  const li = document.createElement('li');
  li.className = `audit-event audit-${event.type.replace(/_/g, '-')}`;
  const label = EVENT_LABELS[event.type] ?? event.type;
  li.innerHTML =
    `<span class="audit-fn">${escapeHtml(event.functionName)}</span>` +
    `<span class="audit-type">${escapeHtml(label)}</span>` +
    `<span class="audit-detail">${renderAuditDetail(event)}</span>`;
  els.auditLog.prepend(li);
}

function onAuditEvent(event: AuditEvent): void {
  appendAuditEntry(event);
  // `spawnSubagent` events update the live, in-place run cards.
  board.applyEvent(event);
  // `function_errored` (and only it) renders an append-only error card.
  const errHtml = renderArtifact(event);
  if (errHtml) {
    const li = document.createElement('li');
    li.className = 'artifact artifact-error';
    li.innerHTML = errHtml;
    els.artifactsList.prepend(li);
  }
}

function clearAuditUI(): void {
  els.auditLog.innerHTML = '';
}

els.clearAuditBtn.addEventListener('click', () => {
  if (!agent) return;
  agent.clearAuditLog();
  clearAuditUI();
});

els.clearArtifactsBtn.addEventListener('click', () => {
  board.clear();
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

// Shown when the user cancels an in-flight run. Follows the finalized partial
// bubble if any text streamed; stands alone if nothing streamed yet.
function appendStoppedMarker(): void {
  const el = document.createElement('div');
  el.className = 'message message-stopped';
  el.textContent = '[stopped]';
  els.chatMessages.appendChild(el);
}

// Resolve every pending confirm (active dialog + queued) with `false` so the
// executor's concurrent Promise.allSettled settles and an aborted run actually
// terminates — core's onConfirmRequired isn't abort-aware until P2.1, so
// without this a queued confirm would keep the round alive post-abort.
function rejectPendingConfirms(): void {
  const queued = confirmQueue.splice(0);
  for (const q of queued) q.resolve(false);
  const cleanup = activeConfirmCleanup;
  activeConfirmCleanup = null;
  cleanup?.(false);
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

// The safe read-only subset a subagent may use by default. NEVER includes
// spawnSubagent (recursion guard, enforced in createSubagentTool by filtering). The
// subagent's own write/destructive calls — if you grant it a write tool like
// downloadFile via `tools` — still go through the subagent's onConfirmRequired.
const SAFE_READ_TOOLS = defineToolSet({
  name: 'subagent-safe-read',
  description: 'Read-only bundled tools a subagent may use by default.',
  tools: [
    getCurrentTime,
    generateUuid,
    evaluateMath,
    hashText,
    encodeBase64,
    decodeBase64,
    getViewportInfo,
    getBatteryInfo,
    listLocalStorageKeys,
    getLocalStorageItem,
  ],
});

// Extras registered on the PARENT: downloadFile (write-tier) is available to the
// parent directly and may also be granted to a subagent by naming it in `tools`,
// which exercises the confirm flow (rendered from schema-validated args) for the
// subagent's write-tier call.
const EXTRA_TOOLS = defineToolSet({
  name: 'subagent-extras',
  description: 'File download helper available to the parent and grantable to subagents.',
  tools: [downloadFile],
});

// The subagent's default system prompt: it is a focused worker with no memory of
// the parent conversation, so it must complete a self-contained task and return a
// concise final answer (the parent only sees the trimmed SpawnSubagentResult).
const SUBAGENT_DEFAULT_SYSTEM_PROMPT =
  'You are a focused subagent. You receive a single self-contained task with no prior ' +
  'conversation. Complete it using your tools, then return a concise final answer — the parent ' +
  'agent sees only your final response, so put everything the parent needs there. Do not ask ' +
  'questions; make reasonable assumptions and proceed.';

// The full toolkit surfaced in the parent sidebar. `renderToolsList` only reads
// the `ToolMeta` subset ({ name, description, riskTier }), so the heterogeneous
// tool tuples and the synthetic spawnSubagent entry (whose real FunctionDefinition
// is built lazily at agent-build time with the parent config) all flow in without
// a cast — no handler-contravariance issue.
const SIDEBAR_TOOLS: readonly ToolMeta[] = [
  ...SAFE_READ_TOOLS.tools,
  ...EXTRA_TOOLS.tools,
  {
    name: 'spawnSubagent',
    description: 'Spawn a subagent for a heavy self-contained sub-task.',
    riskTier: 'read',
  },
];

function buildAgent(cfg: AgentConfig): void {
  // Abort any in-flight run from the previous agent before swapping it out.
  if (inFlightController) {
    inFlightController.abort();
    inFlightController = null;
  }

  // A new agent means a fresh conversation — don't leak prior turns (which may
  // have been produced by a different model/endpoint) into the new session.
  conversation.length = 0;
  // The live subagent cards are a derived view of the prior agent's session;
  // a new agent starts fresh, so drop stale ones.
  board.clear();

  const config: ForgewispConfig = {
    llmEndpoint: cfg.endpoint,
    apiKey: cfg.apiKey || undefined,
    model: cfg.model,
    systemPrompt:
      'You are a pure orchestration agent. You have NO read tools of your own — only ' +
      'spawnSubagent (to delegate sub-tasks) and downloadFile (the one tool you may call ' +
      'directly). For any task that needs read tools (time, UUIDs, math, hashing, base64, ' +
      'viewport, battery, localStorage), spawn a subagent via spawnSubagent with a ' +
      'self-contained `task`. The spawnSubagent tool description lists the EXACT tool names ' +
      'the subagent can use — pass those names in `tools` to grant a subset, or omit `tools` ' +
      'to grant the whole pool. The subagent runs to completion and returns only its final ' +
      'answer, keeping its intermediate reasoning and tool calls out of this conversation. ' +
      'The subagent does NOT see this conversation, so put all needed context in `task`. ' +
      'Never include "spawnSubagent" in `tools`. Narrate briefly and give a one-line summary ' +
      'when the task is done.',
    // Orchestration can fan out across multiple spawns plus a direct download, so
    // keep the cap well above the default 10.
    maxToolRounds: 40,
    // The parent's own tools are read-tier, but the SUBAGENT reuses this confirm
    // handler for its write-tier calls (downloadFile), so the wiring is required.
    onConfirmRequired: showConfirmDialog,
    onAuditEvent,
    streaming: {
      reasoning: { mode: 'native' },
      onTextChunk: (chunk: string) => {
        const acc = currentTurnStreamingText;
        if (acc === null) return;
        acc.text += chunk;
        const el = getOrCreateStreamingMessage();
        el.innerHTML = renderMarkdown(acc.text);
      },
      onReasoningChunk: (chunk: string) => {
        els.reasoningSection.classList.remove('hidden');
        els.reasoningOutput.textContent += chunk;
      },
    },
  };

  agent = createAgent(config);
  registerParentTools(agent, config);
}

interface TurnStreamingState {
  text: string;
}
let currentTurnStreamingText: TurnStreamingState | null = null;

// ─── Tool registration ────────────────────────────────────────────────────────

function registerParentTools(a: Agent, parentConfig: ForgewispConfig): void {
  // The parent is a PURE ORCHESTRATOR: it has no read tools of its own, so any read
  // task must be delegated to a subagent. Only downloadFile is registered here, as
  // the one tool the parent may call directly (exercising the inline + confirm path).
  a.registerToolSet(EXTRA_TOOLS);
  // The subagent spawn tool — declared, not hand-wired. The factory reuses the parent
  // config for the subagent's LLM connection, confirm handler, audit sink, and reasoning
  // mode (stripping the orchestrator system prompt and the streaming UI callbacks so the
  // subagent's intermediate output never pollutes this UI). The parent run's AbortSignal
  // is threaded into the handler by the core executor, so aborting this run aborts the
  // in-flight subagent — no closure capture needed. The pool is the safe read set plus
  // downloadFile (write-tier, so still confirm-gated when the subagent calls it).
  a.registerFunction(
    createSubagentTool({
      config: parentConfig,
      tools: [...SAFE_READ_TOOLS.tools, ...EXTRA_TOOLS.tools],
      systemPrompt: SUBAGENT_DEFAULT_SYSTEM_PROMPT,
      maxToolRounds: 15,
    }),
  );
}

// ─── Config overlay ───────────────────────────────────────────────────────────

function showConfigForm(): void {
  els.configOverlay.classList.remove('hidden');
  els.configEndpoint.focus();
}

function hideConfigForm(): void {
  els.configOverlay.classList.add('hidden');
}

// ─── Chat form ────────────────────────────────────────────────────────────────

function setRunInFlight(inFlight: boolean): void {
  els.chatInput.disabled = inFlight;
  // Keep the action button enabled in both states so Stop is always clickable.
  els.sendButton.disabled = false;
  els.sendButton.textContent = inFlight ? 'Stop' : 'Send';
  els.sendButton.setAttribute('aria-label', inFlight ? 'Stop generation' : 'Send message');
  els.sendButton.type = inFlight ? 'button' : 'submit';
  els.sendButton.classList.toggle('stop', inFlight);
  els.examplePrompts.querySelectorAll<HTMLButtonElement>('button.example-prompt').forEach((b) => {
    b.disabled = inFlight;
  });
}

// Cancel the in-flight run: reject any pending confirm first (so the round
// actually terminates), then abort the controller.
function abortRun(): void {
  rejectPendingConfirms();
  inFlightController?.abort();
}

async function handleChatSubmit(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text || !agent) return;
  if (inFlightController) return; // race guard — already a run in flight

  appendUserMessage(text);
  els.chatInput.value = '';
  setRunInFlight(true);
  showThinkingPlaceholder();

  // Per-turn streaming buffer; not module-level, so concurrent turns can't
  // cross-pollinate (and rebuilds don't inherit stale state).
  currentTurnStreamingText = { text: '' };
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
    if (result.failed) {
      // A terminal LLM failure (non-retryable error, or a retryable one that
      // exhausted the loop-level retry budget) resolves with `failed: true`
      // instead of rejecting — surface it as an error bubble. The catch below
      // only fires for aborts / unexpected throws, not for failed runs.
      appendAssistantMessage(`[error] ${result.error ?? 'The run failed for an unknown reason.'}`);
    } else if (result.response) {
      conversation.push({ role: 'user', content: text });
      conversation.push({ role: 'assistant', content: result.response });
      // If the response was already rendered via streaming chunks, don't duplicate it.
      if (!streamingEl) {
        appendAssistantMessage(result.response);
      }
    }
  } catch (err) {
    finalizeStreamingMessage();
    if (controller.signal.aborted) {
      // Intentional Stop — surface as a stopped state, not an error. The
      // finalized partial bubble (if any text streamed) stays for the user.
      appendStoppedMarker();
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      appendAssistantMessage(`[error] ${msg}`);
    }
  } finally {
    inFlightController = null;
    currentTurnStreamingText = null;
    removeThinkingPlaceholder();
    setRunInFlight(false);
    els.chatInput.focus();
  }
}

els.chatForm.addEventListener('submit', (e: SubmitEvent) => void handleChatSubmit(e));

// The action button doubles as Stop while a run is in flight (type is switched
// to "button" in setRunInFlight, so this click won't trigger a form submit).
els.sendButton.addEventListener('click', (e: MouseEvent) => {
  // A run is in flight → this click is a Stop. Ignore the trailing click(s) of
  // a multi-click gesture (e.detail >= 2): a rapid double-click on Send starts
  // the run on the first click (which flips this button to Stop), and the
  // second click must NOT abort that just-started run. A genuine Stop is its
  // own gesture (e.detail === 1; a programmatic .click() is 0), so it still
  // aborts normally.
  if (inFlightController && e.detail < 2) {
    e.preventDefault();
    abortRun();
  }
});

// ─── Config form handler ──────────────────────────────────────────────────────

els.configForm.addEventListener('submit', (e: SubmitEvent) => {
  e.preventDefault();
  const cfg: AgentConfig = {
    endpoint: els.configEndpoint.value.trim(),
    model: els.configModel.value.trim(),
    apiKey: els.configApikey.value.trim(),
  };
  if (!cfg.endpoint || !cfg.model) return;
  localStorage.setItem('forgewisp.subagent-demo.config', JSON.stringify(cfg));
  buildAgent(cfg);
  hideConfigForm();
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
  const stored = localStorage.getItem('forgewisp.subagent-demo.config');
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isAgentConfig(parsed)) {
    // Corrupt or shape-mismatched — clear it so the user gets a clean form.
    localStorage.removeItem('forgewisp.subagent-demo.config');
    return null;
  }
  return parsed;
}

// ─── Example prompt chips ─────────────────────────────────────────────────────

// One-click "heavy task" prompts so visitors immediately see the parent delegate
// to a subagent. Every read prompt forces delegation: the parent has no read tools
// of its own, so it must spawn a subagent to satisfy any of these. Text is set via
// textContent (no parsing), so the prompts are safe even if edited to include markup.
const EXAMPLE_PROMPTS = [
  'Research the current time, hash it, base64-encode the hash, and give me a one-line summary of all three.',
  'Survey this browser: report the viewport size, battery level, and a fresh UUID, summarized in one line.',
];

function renderExamplePrompts(): void {
  els.examplePrompts.innerHTML = '';
  for (const prompt of EXAMPLE_PROMPTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'example-prompt';
    btn.textContent = prompt;
    btn.addEventListener('click', () => {
      // The race guard in handleChatSubmit covers a click during an in-flight run.
      if (inFlightController) return;
      els.chatInput.value = prompt;
      els.chatForm.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
    });
    els.examplePrompts.appendChild(btn);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

els.toolsList.innerHTML = renderToolsList(SIDEBAR_TOOLS);
renderExamplePrompts();

const stored = loadStoredConfig();
if (stored) {
  buildAgent(stored);
} else {
  showConfigForm();
}
