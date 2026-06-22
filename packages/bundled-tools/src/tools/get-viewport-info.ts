import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no-arg tool
export interface GetViewportInfoArgs {}

export interface GetViewportInfoResult {
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  screenWidth: number;
  screenHeight: number;
  userAgent: string;
  language: string;
  onLine: boolean;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const getViewportInfo: FunctionDefinition<GetViewportInfoArgs> = defineTool({
  name: 'getViewportInfo',
  description:
    'Read the current browser viewport and environment: window size, device pixel ratio, ' +
    'screen size, user agent, language, and online status.',
  riskTier: 'read',
  parameters,
  handler: (): GetViewportInfoResult => {
    if (typeof window === 'undefined') {
      throw new Error('Not running in a browser environment.');
    }
    return {
      innerWidth: window.innerWidth ?? 0,
      innerHeight: window.innerHeight ?? 0,
      devicePixelRatio: window.devicePixelRatio ?? 1,
      screenWidth: screen.width ?? 0,
      screenHeight: screen.height ?? 0,
      userAgent: navigator.userAgent ?? '',
      language: navigator.language ?? '',
      onLine: navigator.onLine ?? false,
    };
  },
});
