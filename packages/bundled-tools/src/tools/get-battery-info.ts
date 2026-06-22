import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no-arg tool
export interface GetBatteryInfoArgs {}

export interface GetBatteryInfoResult {
  /** Whether the Battery API is supported in this browser. */
  supported: boolean;
  /** Whether the device is currently charging. */
  charging?: boolean;
  /** Battery level in [0, 1]. */
  level?: number;
  /** Seconds until fully charged. */
  chargingTime?: number;
  /** Seconds until fully discharged. */
  dischargingTime?: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

// ─── Types ────────────────────────────────────────────────────────────────────

// `navigator.getBattery()` was removed from lib.dom.d.ts after the Battery API was
// dropped from the spec, but Chromium still ships it. Type it locally and detect
// at runtime rather than relying on the lib declaration.
interface BatteryLike {
  charging: boolean;
  level: number;
  chargingTime: number;
  dischargingTime: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryLike>;
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const getBatteryInfo: FunctionDefinition<GetBatteryInfoArgs> = defineTool({
  name: 'getBatteryInfo',
  description:
    'Read the device battery status (level, charging, time remaining) via the Battery API. ' +
    'Returns { supported: false } if the browser does not implement the Battery API.',
  riskTier: 'read',
  parameters,
  handler: async (): Promise<GetBatteryInfoResult> => {
    const getBattery = (navigator as NavigatorWithBattery).getBattery;
    if (typeof getBattery !== 'function') {
      return { supported: false };
    }
    const battery = await getBattery.call(navigator);
    return {
      supported: true,
      charging: battery.charging,
      level: battery.level,
      chargingTime: battery.chargingTime,
      dischargingTime: battery.dischargingTime,
    };
  },
});
