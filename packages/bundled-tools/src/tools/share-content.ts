import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface ShareContentArgs {
  /** Optional title for the shared content. */
  title?: string;
  /** Optional text body to share. */
  text?: string;
  /** Optional URL to share. */
  url?: string;
}

export interface ShareContentResult {
  /** Whether the user completed the share. */
  shared: boolean;
  /** Why the share did not happen, when shared is false. */
  reason?: 'cancelled';
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Optional title for the shared content.',
      maxLength: 200,
    },
    text: {
      type: 'string',
      description: 'Optional text body to share. At least one of text or url is required.',
      maxLength: 5000,
    },
    url: {
      type: 'string',
      description:
        'Optional URL to share. Must be an absolute URL. At least one of text or url is required.',
      maxLength: 2048,
    },
  },
  required: [],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const shareContent: FunctionDefinition<ShareContentArgs> = defineTool({
  name: 'shareContent',
  description:
    'Open the native Web Share sheet (navigator.share) with a title/text/url. ' +
    'The browser prompts the user to pick a share target; cancellation is reported as ' +
    '{ shared: false, reason: "cancelled" } rather than an error.',
  riskTier: 'write',
  parameters,
  handler: async (args: ShareContentArgs): Promise<ShareContentResult> => {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      throw new Error('Web Share API unavailable in this environment.');
    }
    if (!args.text && !args.url) {
      throw new Error('shareContent requires at least one of text or url.');
    }
    if (args.url) {
      try {
        new URL(args.url);
      } catch {
        throw new Error(`Invalid url "${args.url}". Must be an absolute URL.`);
      }
    }
    try {
      await navigator.share({ title: args.title, text: args.text, url: args.url });
      return { shared: true };
    } catch (err) {
      // AbortError is the user dismissing the sheet — normal, not an error.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { shared: false, reason: 'cancelled' };
      }
      throw new Error('Share failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  },
});
