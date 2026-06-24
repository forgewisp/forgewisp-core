// Re-export the core types this package is built around so consumers can import
// everything they need from one place. Type-only re-exports don't affect treeshaking.
export type {
  FunctionDefinition,
  ToolSet,
  RiskTier,
  JSONSchema,
  JSONSchemaProperty,
} from '@forgewisp/core';

// Type-only import for the local `ToolSet` annotation below. This MUST stay
// type-only: a runtime value import from `@forgewisp/core` would force the
// IIFE/global build (which inlines all deps) to resolve core's `dist`, racing
// with core's own `clean: true` watch under `turbo dev --parallel`. Keeping the
// relationship types-only preserves the original "no runtime import of core"
// property so the IIFE build stays self-contained.
import type { ToolSet } from '@forgewisp/core';

export { defineTool } from './define-tool.js';

export { getCurrentTime } from './tools/index.js';
export type { GetCurrentTimeArgs, GetCurrentTimeResult } from './tools/index.js';

export { generateUuid } from './tools/index.js';
export type { GenerateUuidArgs, GenerateUuidResult } from './tools/index.js';

export { evaluateMath } from './tools/index.js';
export type { EvaluateMathArgs, EvaluateMathResult } from './tools/index.js';

export { hashText } from './tools/index.js';
export type { HashTextArgs, HashTextResult } from './tools/index.js';

export { encodeBase64 } from './tools/index.js';
export type { EncodeBase64Args, EncodeBase64Result } from './tools/index.js';

export { decodeBase64 } from './tools/index.js';
export type { DecodeBase64Args, DecodeBase64Result } from './tools/index.js';

export { getViewportInfo } from './tools/index.js';
export type { GetViewportInfoArgs, GetViewportInfoResult } from './tools/index.js';

export { getBatteryInfo } from './tools/index.js';
export type { GetBatteryInfoArgs, GetBatteryInfoResult } from './tools/index.js';

export { listLocalStorageKeys } from './tools/index.js';
export type { ListLocalStorageKeysArgs, ListLocalStorageKeysResult } from './tools/index.js';

export { getLocalStorageItem } from './tools/index.js';
export type { GetLocalStorageItemArgs, GetLocalStorageItemResult } from './tools/index.js';

export { copyToClipboard } from './tools/index.js';
export type { CopyToClipboardArgs, CopyToClipboardResult } from './tools/index.js';

export { speakText } from './tools/index.js';
export type { SpeakTextArgs, SpeakTextResult } from './tools/index.js';

export { downloadFile } from './tools/index.js';
export type { DownloadFileArgs, DownloadFileResult } from './tools/index.js';

export { setLocalStorageItem } from './tools/index.js';
export type { SetLocalStorageItemArgs, SetLocalStorageItemResult } from './tools/index.js';

export { getGeolocation } from './tools/index.js';
export type { GetGeolocationArgs, GetGeolocationResult } from './tools/index.js';

export { removeLocalStorageItem } from './tools/index.js';
export type { RemoveLocalStorageItemArgs, RemoveLocalStorageItemResult } from './tools/index.js';

// Planning tools (agent job-tracking scratchpad persisted in localStorage).
export { listPlans } from './tools/index.js';
export type { ListPlansArgs, ListPlansResult } from './tools/index.js';

export { getPlan } from './tools/index.js';
export type { GetPlanArgs, GetPlanResult } from './tools/index.js';

export { createPlan } from './tools/index.js';
export type { CreatePlanArgs, CreatePlanResult, CreatePlanItemInput } from './tools/index.js';

export { addPlanItem } from './tools/index.js';
export type { AddPlanItemArgs, AddPlanItemResult } from './tools/index.js';

export { updatePlanItem } from './tools/index.js';
export type { UpdatePlanItemArgs, UpdatePlanItemResult } from './tools/index.js';

export { removePlanItem } from './tools/index.js';
export type { RemovePlanItemArgs, RemovePlanItemResult } from './tools/index.js';

export { deletePlan } from './tools/index.js';
export type { DeletePlanArgs, DeletePlanResult } from './tools/index.js';

// Shared plan domain types (the store module itself is not re-exported as a value —
// it is an internal helper, like `eval-math.ts`).
export type { Plan, PlanItem, PlanStatus, PlanPriority, PlanSummary } from './plan-store.js';

// NOTE: the subagent orchestration factory (`createSubagentTool`) used to live here. It has
// moved to `@forgewisp/core`: the factory builds + runs a fresh subagent per call, which needs
// `createAgent` at runtime — a same-package call in core, but a cross-package runtime dep
// here that would break this package's types-only/self-contained-IIFE relationship with core.
// Import it from `@forgewisp/core` instead.

import { getCurrentTime } from './tools/index.js';
import { generateUuid } from './tools/index.js';
import { evaluateMath } from './tools/index.js';
import { hashText } from './tools/index.js';
import { encodeBase64 } from './tools/index.js';
import { decodeBase64 } from './tools/index.js';
import { getViewportInfo } from './tools/index.js';
import { getBatteryInfo } from './tools/index.js';
import { listLocalStorageKeys } from './tools/index.js';
import { getLocalStorageItem } from './tools/index.js';
import { copyToClipboard } from './tools/index.js';
import { speakText } from './tools/index.js';
import { downloadFile } from './tools/index.js';
import { setLocalStorageItem } from './tools/index.js';
import { getGeolocation } from './tools/index.js';
import { removeLocalStorageItem } from './tools/index.js';
import { listPlans } from './tools/index.js';
import { getPlan } from './tools/index.js';
import { createPlan } from './tools/index.js';
import { addPlanItem } from './tools/index.js';
import { updatePlanItem } from './tools/index.js';
import { removePlanItem } from './tools/index.js';
import { deletePlan } from './tools/index.js';

/**
 * Every bundled tool, ready to register. Use:
 *
 *   import { createAgent } from '@forgewisp/core';
 *   import { BUNDLED_TOOLS } from '@forgewisp/bundled-tools';
 *   const agent = createAgent(config);
 *   BUNDLED_TOOLS.forEach((def) => agent.registerFunction(def));
 *
 * Append new tools here as they are added under `src/tools/`. Grouped by tier
 * (read → write → destructive) for stable ordering.
 */
export const BUNDLED_TOOLS = [
  // read
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
  // read — agent job-tracking scratchpad (forgewisp.plans); see plan-store.ts.
  // read-tier by exception: agent-owned, bounded, schema-validated scratchpad,
  // so the agent self-manages its job without onConfirmRequired prompts.
  listPlans,
  getPlan,
  createPlan,
  addPlanItem,
  updatePlanItem,
  removePlanItem,
  deletePlan,
  // write
  copyToClipboard,
  speakText,
  downloadFile,
  setLocalStorageItem,
  getGeolocation,
  // destructive
  removeLocalStorageItem,
] as const;

/**
 * The 7 plan-management tools as a ready-to-register `ToolSet`:
 * `listPlans`, `getPlan`, `createPlan`, `addPlanItem`, `updatePlanItem`,
 * `removePlanItem`, `deletePlan`. All read-tier by exception (agent-owned scratchpad;
 * see plan-store.ts header), so the agent self-manages them with no `onConfirmRequired`
 * prompts. Register in one call:
 *
 *   agent.registerToolSet(PLANNING_TOOLS);
 *
 * Built as a plain `ToolSet`-typed literal (not via `defineToolSet`) so this package
 * keeps a types-only relationship with `@forgewisp/core` — see the import note above.
 * The heterogeneous tuple is assignable to `readonly FunctionDefinition<never>[]`
 * without a cast (handler contravariance + `never` as the covariant read type).
 * Compose with other tools by spreading `.tools` into a `defineToolSet` call.
 */
export const PLANNING_TOOLS: ToolSet = {
  name: 'planning',
  description: 'Agent job-tracking scratchpad persisted in localStorage.',
  tools: [listPlans, getPlan, createPlan, addPlanItem, updatePlanItem, removePlanItem, deletePlan],
};
