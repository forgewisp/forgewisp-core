/**
 * Persistent plan store for the agent-facing planning tools.
 *
 * This is an internal helper module — it is intentionally **not** re-exported from
 * the package barrel (`src/index.ts`) as a value, mirroring the `eval-math.ts`
 * pattern. The tool files in `src/tools/` are thin `defineTool` wrappers over these
 * functions; consumers reach the capability through the tools, not the store.
 *
 * Plans are persisted in `localStorage` under a single namespaced key
 * (`forgewisp.plans`) as a serialized JSON blob: `Record<planId, Plan>`. A single
 * blob (rather than one key per plan) keeps listing atomic and avoids key pollution
 * alongside the existing `setLocalStorageItem` / `removeLocalStorageItem` tools.
 *
 * Reads never throw on corrupt state — a missing or unparseable blob is treated as
 * an empty store so the agent can recover by recreating plans. Mutations throw
 * clear `Error`s (missing plan/item, empty patch, quota) so the core can surface
 * them as `function_errored` audit events.
 *
 * ── Risk-tier rationale ──────────────────────────────────────────────────────
 * The planning tools are the agent's own job-tracking scratchpad: the agent uses
 * them to lay out and track the steps of the task it is working on. Accordingly
 * every plan tool is `read`-tier, so the agent self-manages its scratchpad without
 * `onConfirmRequired` prompts. This is a **deliberate, narrow exception** to the
 * rule that localStorage-mutating tools are gated (`setLocalStorageItem` is `write`,
 * `removeLocalStorageItem` is `destructive`). It is justified because
 * `forgewisp.plans` is an agent-owned, bounded (MAX_PLAN_ITEMS), single-key,
 * schema-validated scratchpad — analogous to the agent's reasoning buffer, not
 * arbitrary user-controlled storage. It is an exception, not a precedent; it does
 * not license demoting the generic localStorage tools.
 *
 * ── Concurrency invariant ────────────────────────────────────────────────────
 * The core executor runs validated tool calls concurrently via `Promise.allSettled`
 * within a round, but it evaluates each handler as `await Promise.resolve(handler(args))`
 * — i.e. the handler (a sync function) runs to completion *before* the await yields.
 * Because every mutation below is fully synchronous with no `await` between
 * `loadAll()` and `saveAll()`, each read-modify-write is atomic and two mutations
 * issued in the same round cannot interleave. **Keep the mutation functions
 * synchronous and never insert an `await` between `loadAll()` and `saveAll()`**,
 * or that atomicity is lost and a real race appears.
 */

/** The localStorage key holding the serialized `Record<planId, Plan>` blob. */
export const PLAN_STORE_KEY = 'forgewisp.plans';

/** Maximum number of items a single plan may hold. */
export const MAX_PLAN_ITEMS = 200;

export type PlanStatus = 'todo' | 'in_progress' | 'done';

export type PlanPriority = 'low' | 'medium' | 'high';

export interface PlanItem {
  /** RFC 4122 v4 UUID. */
  id: string;
  title: string;
  status: PlanStatus;
  priority?: PlanPriority;
  notes?: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

export interface Plan {
  id: string;
  title: string;
  createdAt: string;
  items: PlanItem[];
}

/** Compact projection returned by `listPlans` — cheap for the model to read. */
export interface PlanSummary {
  id: string;
  title: string;
  itemCount: number;
  doneCount: number;
  createdAt: string;
}

/** Input shape for a new item (no id/status/createdAt — those are assigned). */
export interface NewPlanItemInput {
  title: string;
  priority?: PlanPriority;
  notes?: string;
}

/** Patch shape for `updatePlanItem` — every field is optional. */
export interface PlanItemPatch {
  title?: string;
  status?: PlanStatus;
  priority?: PlanPriority;
  notes?: string;
}

/** Result shape for removal operations — the literal `true` is an ack marker. */
export interface RemovalResult {
  removed: true;
  existed: boolean;
}

// ─── Storage access ──────────────────────────────────────────────────────────

function requireStorage(): Storage {
  const storage = globalThis.localStorage;
  if (!storage) {
    throw new Error('localStorage is unavailable in this environment.');
  }
  return storage;
}

/**
 * Read and parse the plan store. Returns an empty record when the key is absent
 * or the blob fails to parse — never throws, so a corrupt store is recoverable.
 */
export function loadAll(): Record<string, Plan> {
  const storage = globalThis.localStorage;
  if (!storage) return {};
  const raw = storage.getItem(PLAN_STORE_KEY);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, Plan>;
}

/** Serialize and write the whole store. Throws on quota errors. */
export function saveAll(plans: Record<string, Plan>): void {
  const storage = requireStorage();
  storage.setItem(PLAN_STORE_KEY, JSON.stringify(plans));
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Generate an RFC 4122 v4 UUID, throwing if the Web Crypto API is missing. */
export function genId(): string {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || typeof cryptoObj.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is unavailable in this environment.');
  }
  return cryptoObj.randomUUID();
}

/** Current instant as an ISO 8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

function findPlan(plans: Record<string, Plan>, planId: string): Plan {
  const plan = plans[planId];
  if (!plan) {
    throw new Error(`No plan with id "${planId}".`);
  }
  return plan;
}

function findItem(plan: Plan, itemId: string): PlanItem {
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) {
    throw new Error(`No item with id "${itemId}" in plan "${plan.id}".`);
  }
  return item;
}

function makeItem(input: NewPlanItemInput): PlanItem {
  const item: PlanItem = {
    id: genId(),
    title: input.title,
    status: 'todo',
    createdAt: nowIso(),
  };
  if (input.priority !== undefined) item.priority = input.priority;
  if (input.notes !== undefined) item.notes = input.notes;
  return item;
}

// ─── Domain operations ───────────────────────────────────────────────────────

/** Create and persist a new plan, optionally seeded with items. Returns the plan. */
export function createPlan(title: string, items?: NewPlanItemInput[]): Plan {
  if (title.length === 0) {
    throw new Error('Plan title must not be empty.');
  }
  const plans = loadAll();
  const plan: Plan = {
    id: genId(),
    title,
    createdAt: nowIso(),
    items: (items ?? []).map(makeItem),
  };
  plans[plan.id] = plan;
  saveAll(plans);
  return plan;
}

/** List all plans as compact summaries (no item bodies). */
export function listPlans(): PlanSummary[] {
  const plans = loadAll();
  return Object.values(plans).map((plan) => ({
    id: plan.id,
    title: plan.title,
    itemCount: plan.items.length,
    doneCount: plan.items.filter((i) => i.status === 'done').length,
    createdAt: plan.createdAt,
  }));
}

/** Get a full plan (with all items). Throws if the plan id is unknown. */
export function getPlan(planId: string): Plan {
  const plans = loadAll();
  return findPlan(plans, planId);
}

/** Add an item to a plan and persist it. Returns the created item. */
export function addPlanItem(planId: string, input: NewPlanItemInput): PlanItem {
  const plans = loadAll();
  const plan = findPlan(plans, planId);
  if (plan.items.length >= MAX_PLAN_ITEMS) {
    throw new Error(`Plan "${plan.title}" is full (max ${MAX_PLAN_ITEMS} items).`);
  }
  const item = makeItem(input);
  plan.items.push(item);
  saveAll(plans);
  return item;
}

/** Update fields of an item. Throws if the plan/item id is unknown or the patch is empty. */
export function updatePlanItem(planId: string, itemId: string, patch: PlanItemPatch): PlanItem {
  const hasPatch =
    patch.title !== undefined ||
    patch.status !== undefined ||
    patch.priority !== undefined ||
    patch.notes !== undefined;
  if (!hasPatch) {
    throw new Error('Provide at least one field to update (title, status, priority, or notes).');
  }
  const plans = loadAll();
  const plan = findPlan(plans, planId);
  const item = findItem(plan, itemId);
  if (patch.title !== undefined) item.title = patch.title;
  if (patch.status !== undefined) item.status = patch.status;
  if (patch.priority !== undefined) item.priority = patch.priority;
  if (patch.notes !== undefined) item.notes = patch.notes;
  saveAll(plans);
  return item;
}

/** Remove an item from a plan. Returns whether it existed. */
export function removePlanItem(planId: string, itemId: string): RemovalResult {
  const plans = loadAll();
  const plan = findPlan(plans, planId);
  const before = plan.items.length;
  plan.items = plan.items.filter((i) => i.id !== itemId);
  const existed = plan.items.length < before;
  saveAll(plans);
  return { removed: true, existed };
}

/** Delete an entire plan. Returns whether it existed. */
export function deletePlan(planId: string): RemovalResult {
  const plans = loadAll();
  const existed = planId in plans;
  if (existed) {
    delete plans[planId];
    saveAll(plans);
  }
  return { removed: true, existed };
}
