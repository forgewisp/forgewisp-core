import type { FunctionDefinition } from '@forgewisp/core';

/**
 * Identity helper that gives tool authors handler argument-type inference.
 *
 * Each tool declares a `TArgs` shape (e.g. `{ timezone?: string }`) and `defineTool`
 * infers it from the `handler` signature, so the handler body reads `args.timezone`
 * instead of `(args as { timezone?: string }).timezone`. The `parameters` JSON Schema
 * is still hand-authored — it cannot be derived from the TS type without a runtime
 * schema builder, which we deliberately do not add a dependency for.
 *
 * The function itself is erased at runtime (treeshaken in the iife build).
 *
 * `TArgs` is deliberately unconstrained to match `FunctionDefinition<TArgs = ...>` in
 * @forgewisp/core, which only *defaults* `TArgs` to `Record<string, unknown>` without
 * constraining it. An interface arg shape (e.g. `{ timezone?: string }`) is not assignable
 * to `Record<string, unknown>` — interfaces have no implicit index signature — so a
 * constraint here would reject exactly the typed-args usage this helper exists to enable.
 */
export function defineTool<TArgs>(def: FunctionDefinition<TArgs>): FunctionDefinition<TArgs> {
  return def;
}
