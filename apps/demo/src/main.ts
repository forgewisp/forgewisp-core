import { createAgent } from '@forgewisp/core';
import type {
  AgentResult,
  AuditEvent,
  ChatMessage,
  FunctionDefinition,
  PendingCall,
  ForgewispConfig,
} from '@forgewisp/core';
import {
  renderArgsHtml,
  renderAuditDetail,
  renderMarkdown,
  renderTaskList,
  escapeHtml,
} from './render.js';

// ─── Sanitization note ────────────────────────────────────────────────────────
// Every sink that turns model- or user-adjacent text into HTML goes through
// DOMPurify (via the helpers in render.ts). The model can return arbitrary
// markdown (including raw HTML); without sanitization,
// `<img src=x onerror=…>` would execute in the page.

// ─── Task store ───────────────────────────────────────────────────────────────

interface Task {
  id: number;
  title: string;
  done: boolean;
}

let tasks: Task[] = [
  { id: 1, title: 'Set up the project repository', done: false },
  { id: 2, title: 'Write the README', done: false },
  { id: 3, title: 'Ship v1 to npm', done: false },
];
let nextId = 4;

function renderTasks(): void {
  els.taskList.innerHTML = renderTaskList(tasks);
}

// ─── Cached DOM refs ──────────────────────────────────────────────────────────

interface Elements {
  taskList: HTMLUListElement;
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
  if (!el) throw new Error(`[demo] Missing element #${id}`);
  return el as T;
}

const els: Elements = {
  taskList: getEl<HTMLUListElement>('task-list'),
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

// ─── Audit log ────────────────────────────────────────────────────────────────

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

  const config: ForgewispConfig = {
    llmEndpoint: cfg.endpoint,
    apiKey: cfg.apiKey || undefined,
    model: cfg.model,
    systemPrompt:
      'You are a task-management assistant. Use the provided tools to read, ' +
      'modify, and delete tasks. Always prefer tools over guessing task state.',
    onConfirmRequired: showConfirmDialog,
    onAuditEvent: appendAuditEntry,
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

// ─── Tool registrations (table-driven) ────────────────────────────────────────

const TOOLS: FunctionDefinition[] = [
  {
    name: 'listTasks',
    description: 'List all tasks with their id, title, and done status.',
    riskTier: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: () => tasks,
  },
  {
    name: 'addTask',
    description: 'Add a new task with the given title.',
    riskTier: 'write',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, description: 'Task title' } },
      required: ['title'],
    },
    handler: (args: Record<string, unknown>) => {
      const title = args.title as string;
      const task: Task = { id: nextId++, title, done: false };
      tasks.push(task);
      renderTasks();
      return task;
    },
  },
  {
    name: 'markTaskDone',
    description: 'Mark an existing task as done by id.',
    riskTier: 'write',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1, description: 'Task id' } },
      required: ['id'],
    },
    handler: (args: Record<string, unknown>) => {
      const id = args.id as number;
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new Error(`No task with id ${id}`);
      task.done = true;
      renderTasks();
      return task;
    },
  },
  {
    name: 'deleteTask',
    description: 'Permanently delete a task by id.',
    riskTier: 'destructive',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1, description: 'Task id' } },
      required: ['id'],
    },
    handler: (args: Record<string, unknown>) => {
      const id = args.id as number;
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== id);
      if (tasks.length === before) throw new Error(`No task with id ${id}`);
      renderTasks();
      return { deleted: id };
    },
  },
];

function registerTools(a: Agent): void {
  for (const def of TOOLS) a.registerFunction(def);
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
  localStorage.setItem('forgewisp.demo.config', JSON.stringify(cfg));
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
  const stored = localStorage.getItem('forgewisp.demo.config');
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isAgentConfig(parsed)) {
    // Corrupt or shape-mismatched — clear it so the user gets a clean form.
    localStorage.removeItem('forgewisp.demo.config');
    return null;
  }
  return parsed;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

renderTasks();

const stored = loadStoredConfig();
if (stored) {
  buildAgent(stored);
} else {
  showConfigForm();
}
