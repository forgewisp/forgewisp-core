import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface RequestWakeLockArgs {
  /** The kind of wake lock to acquire. Only "screen" is currently defined. */
  type?: 'screen';
}

export interface RequestWakeLockResult {
  /** Whether the wake lock was acquired and is currently held. */
  acquired: boolean;
  /** The lock type that was acquired. */
  type: 'screen';
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['screen'],
      description: 'The kind of wake lock to acquire. Defaults to "screen".',
    },
  },
  required: [],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

// Active sentinels are held in this module-level set. A sentinel is a non-JSON-
// serializable object, so it must NOT be returned from the handler (core's tool
// loop would replace a non-serializable result with a placeholder). The browser
// automatically releases a screen wake lock when the tab is hidden; we attach a
// visibilitychange listener to release all held sentinels promptly and clear the
// set, mirroring the canonical wake-lock usage pattern.
//
// We hold a SET, not a single slot: a second call does NOT silently release a
// previous caller's lock. Multiple screen wake locks are allowed per tab (they
// coalesce into one system lock), so independent callers can each hold their own
// without one superseding the other.
type Sentinel = { release: () => Promise<void>; released?: boolean };
const activeSentinels = new Set<Sentinel>();

function releaseAll(): void {
  for (const sentinel of activeSentinels) {
    void sentinel.release().catch(() => {
      /* already released or tab hidden — ignore */
    });
  }
  activeSentinels.clear();
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });
}

export const requestWakeLock: FunctionDefinition<RequestWakeLockArgs> = defineTool({
  name: 'requestWakeLock',
  description:
    'Acquire a screen wake lock via the Screen Wake Lock API (navigator.wakeLock) to keep the ' +
    'display awake. The lock auto-releases when the tab becomes hidden (browser behavior) or is ' +
    'closed. Returns { acquired: true } — the non-serializable lock sentinel is not returned.',
  riskTier: 'write',
  parameters,
  handler: async (args: RequestWakeLockArgs): Promise<RequestWakeLockResult> => {
    const wakeLock = (navigator as { wakeLock?: { request: (t: string) => Promise<unknown> } })
      .wakeLock;
    if (!wakeLock || typeof wakeLock.request !== 'function') {
      throw new Error('Screen Wake Lock API unavailable in this environment.');
    }
    const type = args.type ?? 'screen';
    try {
      const sentinel = (await wakeLock.request(type)) as Sentinel;
      // The tab may have become hidden during the await, in which case the
      // browser hands back an already-released sentinel. Report that honestly
      // rather than claiming a lock is held.
      const acquired = sentinel.released !== true;
      if (acquired) activeSentinels.add(sentinel);
      return { acquired, type };
    } catch (err) {
      throw new Error(
        'Failed to acquire wake lock: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  },
});
