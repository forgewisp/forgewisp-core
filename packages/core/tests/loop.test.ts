import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runToolLoop, ToolLoopDeps } from '../src/loop.js';
import { FunctionRegistry } from '../src/registry.js';
import { AuditLog } from '../src/audit.js';
import { ForgewispConfig } from '../src/types.js';

const baseConfig: ForgewispConfig = {
  llmEndpoint: 'https://api.example.com/v1/chat/completions',
  model: 'gpt-4o',
};

// A tool-call round followed by a final text round. The tool message handed
// back to the model in round 1 is captured in `seenMessages`.
function makeDeps(
  registry: FunctionRegistry,
  audit: AuditLog,
  config: ForgewispConfig,
  seenMessages: Parameters<ToolLoopDeps['callLLM']>[0][],
): ToolLoopDeps {
  let round = 0;
  const callLLM: ToolLoopDeps['callLLM'] = (messages) => {
    seenMessages.push(messages);
    if (round === 0) {
      round += 1;
      return Promise.resolve({
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'writeData', arguments: JSON.stringify({ value: 'x' }) },
            },
          ],
        },
        reasoning: '',
      });
    }
    return Promise.resolve({
      message: { role: 'assistant', content: 'ok, I will not retry' },
      reasoning: '',
    });
  };
  return { callLLM, registry, audit, config, maxToolRounds: 5 };
}

describe('runToolLoop — confirmation cancellation', () => {
  let registry: FunctionRegistry;
  let audit: AuditLog;

  beforeEach(() => {
    registry = new FunctionRegistry();
    audit = new AuditLog();
    registry.register({
      name: 'writeData',
      description: 'Write',
      riskTier: 'write',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      handler: vi.fn(),
    });
  });

  it('tells the LLM the user declined and not to retry (not a generic error)', async () => {
    const seenMessages: Parameters<ToolLoopDeps['callLLM']>[0][] = [];
    const deps = makeDeps(
      registry,
      audit,
      { ...baseConfig, onConfirmRequired: vi.fn().mockResolvedValue(false) },
      seenMessages,
    );

    const result = await runToolLoop(deps, 'please write x');

    // Round 1 receives the tool result message produced from the cancel.
    const round1 = seenMessages[1]!;
    const toolMessage = round1.find(
      (m) => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'call_1',
    );

    expect(toolMessage).toBeDefined();
    const content = (toolMessage as { content: string }).content;
    // Plain, directive text — not the old {"error":"confirmation_rejected"} shape.
    expect(content).not.toBe(JSON.stringify({ error: 'confirmation_rejected' }));
    expect(content.toLowerCase()).toContain('declined');
    expect(content.toLowerCase()).toContain('do not retry');

    // Loop still terminated normally with the model's final response.
    expect(result.truncated).toBe(false);
    expect(result.response).toBe('ok, I will not retry');
    expect(result.toolCallsAborted[0]?.reason).toBe('confirmation_rejected');
  });
});
