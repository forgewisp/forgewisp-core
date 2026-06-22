import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface GetCurrentTimeArgs {
  /** Optional IANA timezone identifier. Defaults to the host's local zone. */
  timezone?: string;
}

export interface GetCurrentTimeResult {
  /** Always a UTC ISO 8601 string, e.g. "2026-06-22T14:30:00.000Z". */
  iso: string;
  /** The IANA timezone that `local` and `offsetMinutes` were computed in. */
  timezone: string;
  /** Minutes east of UTC at the rendered instant (negative = west). */
  offsetMinutes: number;
  /** Human-readable, localized full date+time in the target zone. */
  local: string;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    timezone: {
      type: 'string',
      description:
        'IANA timezone identifier, e.g. "America/New_York", "Europe/London", "Asia/Tokyo". ' +
        'Defaults to the host system local timezone when omitted.',
      minLength: 1,
      maxLength: 100,
    },
  },
  required: [],
  additionalProperties: false,
};

// ─── Offset computation ──────────────────────────────────────────────────────

function pick(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '0';
}

function partsToUtcMs(parts: Intl.DateTimeFormatPart[]): number {
  const hour = Number.parseInt(pick(parts, 'hour'), 10);
  // `hour12: false` emits "24" at midnight on some engines; normalize to 0.
  return Date.UTC(
    Number.parseInt(pick(parts, 'year'), 10),
    Number.parseInt(pick(parts, 'month'), 10) - 1,
    Number.parseInt(pick(parts, 'day'), 10),
    hour === 24 ? 0 : hour,
    Number.parseInt(pick(parts, 'minute'), 10),
    Number.parseInt(pick(parts, 'second'), 10),
  );
}

/** Returns the offset, in minutes east of UTC, of `timeZone` at the given instant. */
function offsetMinutes(timeZone: string, now: Date): number {
  const fullOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  };
  const tzParts = new Intl.DateTimeFormat('en-US', { ...fullOptions, timeZone }).formatToParts(now);
  const utcParts = new Intl.DateTimeFormat('en-US', {
    ...fullOptions,
    timeZone: 'UTC',
  }).formatToParts(now);
  return Math.round((partsToUtcMs(tzParts) - partsToUtcMs(utcParts)) / 60000);
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const getCurrentTime: FunctionDefinition<GetCurrentTimeArgs> = defineTool({
  name: 'getCurrentTime',
  description:
    'Get the current date and time. Optionally return it in a specific IANA timezone. ' +
    'Useful before any scheduling, calendar, or "how long ago" reasoning.',
  riskTier: 'read',
  parameters,
  handler: (args: GetCurrentTimeArgs): GetCurrentTimeResult => {
    const now = new Date();
    const timezone = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

    // Validate the zone before computing the offset; an invalid IANA id throws RangeError.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new Error(
        `Invalid timezone "${timezone}". Use an IANA identifier, e.g. "America/New_York".`,
      );
    }

    return {
      iso: now.toISOString(),
      timezone,
      offsetMinutes: offsetMinutes(timezone, now),
      local: new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now),
    };
  },
});
