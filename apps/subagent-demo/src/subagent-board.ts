import type { AuditEvent } from '@forgewisp/core';
import { renderLiveSubagentCard, type SubagentCardState } from './render.js';

// ─── SubagentBoard ──────────────────────────────────────────────────────────
//
// A derived, in-place view of the subagent runs the parent agent spawns. The
// parent agent owns the authoritative loop; the board does NOT inspect it.
// Instead it reconstructs each run from `spawnSubagent` audit events:
//
//   function_requested(spawnSubagent) → push a "spawning…" card (carries `task`).
//   function_executed(spawnSubagent) → pop the oldest pending card, fill in the
//                                       trimmed result (the tool `result`).
//   function_errored(spawnSubagent)  → pop the oldest pending card, mark errored.
//
// Audit events do NOT carry a tool_call_id, so a specific `function_executed`
// cannot be matched back to a specific `function_requested` by id. We correlate
// them by FIFO order instead: the core executor emits `function_requested` for
// every call in input order before any async work starts, so a queue of pending
// cards drains in the same order. Within a single round multiple spawns run
// concurrently, but their `function_requested` events are still ordered, so the
// queue stays correct.
//
// One persistent <li> card per run is re-rendered in place on completion (same
// DOM node) and moved to the top, so a multi-spawn task shows evolving cards
// (⟳ spawning → ✓ completed) rather than a stack.

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export class SubagentBoard {
  private readonly container: HTMLUListElement;
  // Cards waiting for their function_executed/errored event, in request order.
  private readonly pending: Array<{ state: SubagentCardState; li: HTMLLIElement }> = [];

  constructor(container: HTMLUListElement) {
    this.container = container;
  }

  /** Apply an audit event; only `spawnSubagent` events update the board. */
  applyEvent(event: AuditEvent): void {
    if (event.functionName !== 'spawnSubagent') return;
    switch (event.type) {
      case 'function_requested': {
        const state: SubagentCardState = {
          task: str((event.args ?? {}).task),
          status: 'spawning',
        };
        this.pushCard(state);
        break;
      }
      case 'function_executed': {
        const result = (event.result ?? {}) as Record<string, unknown>;
        this.completeCard({
          status: 'done',
          response: str(result.response),
          truncated: Boolean(result.truncated),
          toolCallsExecuted: num(result.toolCallsExecuted),
          toolCallsAborted: num(result.toolCallsAborted),
        });
        break;
      }
      case 'function_errored': {
        this.completeCard({ status: 'error', error: str(event.error) });
        break;
      }
      default:
        break; // validation_*, confirmation_* — no board change
    }
  }

  /** Drop all runs and clear the panel. */
  clear(): void {
    this.pending.length = 0;
    this.container.innerHTML = '';
  }

  // ── internal ────────────────────────────────────────────────────────────

  /** Push a "spawning…" card and render it at the top of the panel. */
  private pushCard(state: SubagentCardState): void {
    const li = document.createElement('li');
    li.className = 'artifact artifact-subagent';
    li.innerHTML = renderLiveSubagentCard(state);
    this.container.prepend(li);
    this.pending.push({ state, li });
  }

  /**
   * Pop the oldest pending card, merge `patch` into its state, and re-render it
   * in place (same node) at the top. No-op if there is no pending card (e.g. an
   * executed event with no matching requested — shouldn't happen, but stay
   * safe).
   */
  private completeCard(patch: Partial<SubagentCardState>): void {
    const entry = this.pending.shift();
    if (!entry) return;
    const state: SubagentCardState = { ...entry.state, ...patch };
    entry.li.innerHTML = renderLiveSubagentCard(state);
    this.container.prepend(entry.li);
  }
}
