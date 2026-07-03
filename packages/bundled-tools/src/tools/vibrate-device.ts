import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface VibrateDeviceArgs {
  /** Vibration pattern in milliseconds: alternating vibrate/pause starting with vibrate. */
  pattern: number[];
}

export interface VibrateDeviceResult {
  /** Whether the vibration was accepted by the platform. */
  vibrated: boolean;
  /** The pattern that was requested. */
  pattern: number[];
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'array',
      description:
        'Vibration pattern in milliseconds, alternating vibrate/pause, starting with vibrate. ' +
        'A single pulse is [ms]; e.g. [200] or [200, 100, 200].',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'number',
        minimum: 0,
        maximum: 10_000,
      },
    },
  },
  required: ['pattern'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const vibrateDevice: FunctionDefinition<VibrateDeviceArgs> = defineTool({
  name: 'vibrateDevice',
  description:
    'Trigger device vibration via the Vibration API (navigator.vibrate). ' +
    'Unavailable on iOS Safari and desktop browsers; vibrated=false when the platform ' +
    'declines or does not support it.',
  riskTier: 'write',
  parameters,
  handler: (args: VibrateDeviceArgs): VibrateDeviceResult => {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
      throw new Error('Vibration API unavailable in this environment.');
    }
    const vibrated = navigator.vibrate(args.pattern);
    return { vibrated, pattern: args.pattern };
  },
});
