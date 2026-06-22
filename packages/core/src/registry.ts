import { FunctionDefinition } from './types.js';
import type { LLMTool } from './wire.js';

export class FunctionRegistry {
  private functions = new Map<string, FunctionDefinition>();
  private cachedTools: LLMTool[] | undefined;

  register(def: FunctionDefinition): void {
    if (this.functions.has(def.name)) {
      throw new Error(
        `[Forgewisp] A function named "${def.name}" is already registered. ` +
          `Use a unique name or call deregister() first.`,
      );
    }
    this.functions.set(def.name, def);
    this.cachedTools = undefined;
  }

  deregister(name: string): void {
    if (this.functions.delete(name)) {
      this.cachedTools = undefined;
    }
  }

  get(name: string): FunctionDefinition | undefined {
    return this.functions.get(name);
  }

  has(name: string): boolean {
    return this.functions.has(name);
  }

  getAll(): FunctionDefinition[] {
    return Array.from(this.functions.values());
  }

  toLLMTools(): LLMTool[] {
    if (!this.cachedTools) {
      this.cachedTools = this.getAll().map((def) => ({
        type: 'function',
        function: {
          name: def.name,
          description: def.description,
          parameters: def.parameters,
        },
      }));
    }
    return this.cachedTools;
  }

  size(): number {
    return this.functions.size;
  }
}
