import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface GetGeolocationArgs {
  /** Maximum time to wait for a fix, in ms. Defaults to 10000. */
  timeoutMs?: number;
  /** Request a high-accuracy GPS fix. Defaults to false. */
  enableHighAccuracy?: boolean;
}

export interface GetGeolocationResult {
  /** Latitude in decimal degrees. */
  lat: number;
  /** Longitude in decimal degrees. */
  lng: number;
  /** Accuracy of the fix in meters. */
  accuracy: number;
  /** Epoch timestamp (ms) of the position. */
  timestamp: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    timeoutMs: {
      type: 'integer',
      minimum: 100,
      maximum: 60000,
      description: 'Maximum time to wait for a fix, in ms. Defaults to 10000.',
    },
    enableHighAccuracy: {
      type: 'boolean',
      description: 'Request a high-accuracy GPS fix. Defaults to false.',
    },
  },
  required: [],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const getGeolocation: FunctionDefinition<GetGeolocationArgs> = defineTool({
  name: 'getGeolocation',
  description:
    "Get the device's current geographic coordinates via the Geolocation API. Sensitive — " +
    'the browser will prompt the user for permission. Rejects on denial, timeout, or if the ' +
    'API is unavailable.',
  riskTier: 'write',
  parameters,
  handler: (args: GetGeolocationArgs): Promise<GetGeolocationResult> => {
    if (
      typeof navigator === 'undefined' ||
      !('geolocation' in navigator) ||
      !navigator.geolocation
    ) {
      return Promise.reject(new Error('Geolocation API unavailable in this environment.'));
    }
    const timeoutMs = args.timeoutMs ?? 10_000;
    return new Promise<GetGeolocationResult>((resolve, reject) => {
      let settled = false;
      const backstop = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Geolocation timed out.'));
      }, timeoutMs + 1000);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (settled) return;
          settled = true;
          clearTimeout(backstop);
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: pos.timestamp,
          });
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(backstop);
          reject(new Error('Geolocation error: ' + err.message));
        },
        { enableHighAccuracy: args.enableHighAccuracy ?? false, timeout: timeoutMs, maximumAge: 0 },
      );
    });
  },
});
