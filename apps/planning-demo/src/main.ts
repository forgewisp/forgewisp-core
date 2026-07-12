import { createAgent, defineToolSet } from '@forgewisp/core';
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
  downloadFile,
  PLANNING_TOOLS,
} from '@forgewisp/bundled-tools';
import {
  renderArgsHtml,
  renderArtifact,
  renderAuditDetail,
  renderMarkdown,
  renderToolsList,
  escapeHtml,
} from './render.js';
import { PlanBoard } from './plan-board.js';

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
  if (!el) throw new Error(`[planning-demo] Missing element #${id}`);
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

// Derived, in-place view of the plans the agent tracks. Fed by audit events
// (see plan-board.ts); the agent owns the authoritative state in localStorage.
const board = new PlanBoard(els.artifactsList);

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
// dialog, then the next queued call is shown. This keeps the core's per-call
// contract intact while ensuring no confirmation is silently auto-rejected.
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

// ─── Audit log + artifacts ────────────────────────────────────────────────────

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
  // Plan `function_executed` events update the live, in-place plan cards.
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

function buildAgent(cfg: AgentConfig): void {
  // Abort any in-flight run from the previous agent before swapping it out.
  if (inFlightController) {
    inFlightController.abort();
    inFlightController = null;
  }

  // A new agent means a fresh conversation — don't leak prior turns (which may
  // have been produced by a different model/endpoint) into the new session.
  conversation.length = 0;
  // The live plan cards are a derived view of the prior agent's session; a new
  // agent rehydrates them from listPlans/getPlan as it resumes, so drop stale ones.
  board.clear();

  const config: ForgewispConfig = {
    llmEndpoint: cfg.endpoint,
    apiKey: cfg.apiKey || undefined,
    model: cfg.model,
    systemPrompt:
      'You are a planning agent that breaks large requests into concrete steps and tracks them ' +
      'to completion using plan tools. For any request with 2+ steps, call createPlan up front ' +
      'with a short title and the 3-8 steps you foresee — one item per distinct step, merging ' +
      'trivial substeps. Keep one active plan per task; do not create a second plan for the same ' +
      'task. Work the plan in order: set the item to "in_progress" via updatePlanItem when you ' +
      'start it and "done" when you complete it, adding a short notes line about what you found ' +
      'or decided, and prefer one item in_progress at a time. If scope changes, re-plan with ' +
      'addPlanItem/removePlanItem rather than starting over. Call getPlan to re-read the full ' +
      'plan before editing if unsure of current state, and listPlans at the start of a turn to ' +
      'resume an in-progress plan. Prefer removePlanItem over deleting a whole plan; once every ' +
      'item is "done" and the task is complete, call deletePlan to tear down the finished plan ' +
      'before giving your final summary. Use getCurrentTime when scheduling or deadlines matter. ' +
      'Narrate briefly in chat as you complete each step, and give a one-line summary when the ' +
      'plan is done.',
    // Planning turns fan out across many tool calls (createPlan + per-item
    // in_progress/done updates + listPlans/getPlan reads), so lift the cap well
    // above the default 10 — an 8-step plan already needs ~20 rounds.
    maxToolRounds: 40,
    // All registered tools are read-tier, so onConfirmRequired is never invoked. The
    // confirm wiring is retained as a reference for consumers who later add write/destructive tools.
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
  registerTools(agent);
}

interface TurnStreamingState {
  text: string;
}
let currentTurnStreamingText: TurnStreamingState | null = null;

// ─── Tool registration ────────────────────────────────────────────────────────

// Extras registered alongside the planning set: getCurrentTime/generateUuid for
// general use, downloadFile (write-tier) as the example task's final step —
// triggers the confirm flow rendered from schema-validated args. Grouped as a
// ToolSet so registration is a single call and the heterogeneous-args tuple
// needs no `as unknown as` cast (defineToolSet erases via FunctionDefinition<never>).
const EXTRA_TOOLS = defineToolSet({
  name: 'planning-extras',
  description: 'Time/UUID helpers plus file download for the example task.',
  tools: [getCurrentTime, generateUuid, downloadFile],
});

// The full toolkit surfaced in the sidebar: the planning set plus the extras.
const SIDEBAR_TOOLS = [...PLANNING_TOOLS.tools, ...EXTRA_TOOLS.tools];

function registerTools(a: Agent): void {
  // Register the 7 plan-management tools plus the extras, each set in one call.
  a.registerToolSet(PLANNING_TOOLS);
  a.registerToolSet(EXTRA_TOOLS);
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
  localStorage.setItem('forgewisp.planning-demo.config', JSON.stringify(cfg));
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
  const stored = localStorage.getItem('forgewisp.planning-demo.config');
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isAgentConfig(parsed)) {
    // Corrupt or shape-mismatched — clear it so the user gets a clean form.
    localStorage.removeItem('forgewisp.planning-demo.config');
    return null;
  }
  return parsed;
}

// ─── Example prompt chips ──────────────────────────────────────────────────────

// One-click "large task" prompts so visitors immediately see the agent
// decompose a concrete multi-step request. Text is set via textContent (no
// parsing), so the prompts are safe even if edited to include markup.
const EXAMPLE_PROMPTS = [
  'Write a product launch announcement document with an intro, key features, pricing, and a call to action. Download it as a Markdown file as the last step.',
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
