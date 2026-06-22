// Internal OpenAI-compatible wire types. Not re-exported from the package
// entry point — consumers depend on the public types in types.ts only.

import type { JSONSchema } from './types.js';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

/**
 * The assembled result returned by the streaming parser to the agent loop.
 */
export interface StreamResult {
  message: LLMMessage;
  /** Accumulated reasoning text, empty string if none. */
  reasoning: string;
  /** Reasoning token count when the API reports one (o1/o3 extended mode). */
  reasoningTokens?: number;
}

export interface OpenAIChunk {
  choices?: Array<{
    delta: {
      content?: string;
      // Native reasoning fields streamed by some OpenAI-compatible servers:
      // `reasoning` (Ollama) and `reasoning_content` (vLLM/DashScope). Both are
      // optional and ignored unless reasoning mode is 'native'.
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}
