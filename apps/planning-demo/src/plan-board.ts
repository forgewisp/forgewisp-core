import type { AuditEvent } from '@forgewisp/core';
import type { Plan, PlanItem } from '@forgewisp/bundled-tools';
import { renderLivePlanCard } from './render.js';

// ─── PlanBoard ──────────────────────────────────────────────────────────────
//
// A derived, in-place view of the plans the agent is tracking. The agent owns
// the authoritative state in localStorage (`forgewisp.plans` via plan-store); the
// board does NOT read localStorage. Instead it reconstructs each plan from the
// `function_executed` audit events, which carry the tool `result` (and `args`
// for the planId/itemId the tool acted on):
//
//   createPlan / getPlan  → result.plan is the full Plan → replace the plan.
//   addPlanItem           → result.item + args.planId → append the item.
//   updatePlanItem         → result.item + args.planId → patch the item by id.
//   removePlanItem         → args.planId + args.itemId → drop the item.
//   deletePlan             → args.planId → remove the plan.
//   listPlans / others     → no item data → no change.
//
// One persistent <li> card per plan, keyed by planId, is re-rendered in place
// on each event (same DOM node) and moved to the top — so a multi-step task
// shows a single evolving checklist (◻ → ◑ → ✓) rather than a stack of cards.
// On reload the board is empty until the agent calls listPlans/getPlan to resume,
// at which point the live card rehydrates from those events.

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Coerce an unknown value to a `PlanItem` (field-by-field safe). */
function asItem(v: unknown): PlanItem | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.title !== 'string' || typeof o.status !== 'string') {
    return null;
  }
  return o as unknown as PlanItem;
}

/** Coerce an unknown value to a `Plan` (field-by-field safe). */
function asPlan(v: unknown): Plan | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.title !== 'string' || !Array.isArray(o.items)) {
    return null;
  }
  return o as unknown as Plan;
}

export class PlanBoard {
  private readonly container: HTMLUListElement;
  private readonly plans = new Map<string, Plan>();
  // Card element per planId, so updates re-render the SAME node in place.
  private readonly cards = new Map<string, HTMLLIElement>();

  constructor(container: HTMLUListElement) {
    this.container = container;
  }

  /** Apply an audit event; only `function_executed` plan events update the board. */
  applyEvent(event: AuditEvent): void {
    if (event.type !== 'function_executed') return;
    // `event.args` is already `Record<string, unknown> | undefined`, so `?? {}`
    // collapses to `Record<string, unknown>` — no assertion needed. `result` is
    // `unknown`, so it still needs the cast to be indexable.
    const args: Record<string, unknown> = event.args ?? {};
    const result = (event.result ?? {}) as Record<string, unknown>;

    switch (event.functionName) {
      case 'createPlan':
      case 'getPlan': {
        const plan = asPlan(result.plan);
        if (plan) this.setPlan(plan);
        break;
      }
      case 'addPlanItem': {
        const planId = str(args.planId);
        const item = asItem(result.item);
        if (planId && item) this.addItem(planId, item);
        break;
      }
      case 'updatePlanItem': {
        const planId = str(args.planId);
        const item = asItem(result.item);
        if (planId && item) this.patchItem(planId, item);
        break;
      }
      case 'removePlanItem': {
        const planId = str(args.planId);
        const itemId = str(args.itemId);
        if (planId && itemId) this.removeItem(planId, itemId);
        break;
      }
      case 'deletePlan': {
        const planId = str(args.planId);
        if (planId) this.removePlan(planId);
        break;
      }
      default:
        break; // listPlans, getCurrentTime, generateUuid — no board change
    }
  }

  /** Drop all known plans and clear the panel (including any error cards). */
  clear(): void {
    this.plans.clear();
    this.cards.clear();
    this.container.innerHTML = '';
  }

  // ── internal ────────────────────────────────────────────────────────────

  /** Replace (or seed) a plan and move its card to the top. */
  private setPlan(plan: Plan): void {
    this.plans.set(plan.id, plan);
    this.renderCard(plan.id);
  }

  /** Append an item to a plan, seeding a stub if the plan wasn't seen in full. */
  private addItem(planId: string, item: PlanItem): void {
    const plan = this.getOrSeed(planId, item);
    plan.items = plan.items.filter((i) => i.id !== item.id);
    plan.items.push(item);
    this.renderCard(planId);
  }

  /** Patch an item by id (or push it if new), seeding a stub plan if needed. */
  private patchItem(planId: string, item: PlanItem): void {
    const plan = this.getOrSeed(planId, item);
    const idx = plan.items.findIndex((i) => i.id === item.id);
    if (idx === -1) plan.items.push(item);
    else plan.items[idx] = item;
    this.renderCard(planId);
  }

  /** Remove an item from a plan (no-op if the plan is unknown). */
  private removeItem(planId: string, itemId: string): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    plan.items = plan.items.filter((i) => i.id !== itemId);
    this.renderCard(planId);
  }

  /** Remove a plan and its card. */
  private removePlan(planId: string): void {
    this.plans.delete(planId);
    const li = this.cards.get(planId);
    if (li) {
      li.remove();
      this.cards.delete(planId);
    }
  }

  /**
   * Return the plan for planId, seeding a minimal stub if the board hasn't seen
   * it in full yet (rare: the agent used listPlans → addPlanItem without a prior
   * createPlan/getPlan). The stub self-corrects on the next getPlan/createPlan.
   */
  private getOrSeed(planId: string, item: PlanItem): Plan {
    let plan = this.plans.get(planId);
    if (!plan) {
      plan = { id: planId, title: '(unsaved plan)', createdAt: item.createdAt, items: [] };
      this.plans.set(planId, plan);
    }
    return plan;
  }

  /** Re-render a plan's card in place, creating it and moving it to top. */
  private renderCard(planId: string): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    let li = this.cards.get(planId);
    if (!li) {
      li = document.createElement('li');
      li.className = 'artifact artifact-plan';
      li.dataset.planId = planId;
      this.cards.set(planId, li);
    }
    li.innerHTML = renderLivePlanCard(plan);
    // Most recently touched plan on top.
    this.container.prepend(li);
  }
}
