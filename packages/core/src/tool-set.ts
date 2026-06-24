import type { FunctionDefinition, ToolSet } from './types.js';

/**
 * Identity helper for authoring a `ToolSet` from a literal tool tuple, giving you
 * `name`/`description` authoring DX and centralizing the covariant erasure.
 *
 * `TTools` is inferred as the readonly tuple of whatever tools you pass (each a
 * `FunctionDefinition<SpecificArgs>`), which is assignable to
 * `readonly FunctionDefinition<never>[]` without a cast — the handler is contravariant in
 * `TArgs` and `never` is the bottom type, so every specific tool is assignable to
 * `FunctionDefinition<never>`. This is why a heterogeneous tool tuple needs no `as unknown as`
 * workaround here, unlike a plain `readonly FunctionDefinition[]`. Erased at runtime.
 *
 * Compose sets from existing tools or other sets by spreading `.tools`:
 *
 *   defineToolSet({ name: 'mixed', tools: [...PLANNING_TOOLS.tools, getCurrentTime] })
 */
export function defineToolSet<const TTools extends readonly FunctionDefinition<never>[]>(def: {
  readonly name: string;
  readonly description?: string;
  readonly tools: TTools;
}): ToolSet {
  return {
    name: def.name,
    ...(def.description !== undefined ? { description: def.description } : {}),
    tools: def.tools,
  };
}
