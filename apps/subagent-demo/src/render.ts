import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AuditEvent, RiskTier } from '@forgewisp/core';

marked.setOptions({ breaks: true, gfm: true });

// Model-controlled markdown is untrusted: it may contain raw HTML. This allowlist
// is deliberately tight (no <img>, no <script>, no event-handler attributes) and
// MUST NOT grow to accommodate the subagent-card/tools renderers, which use their
// own local allowlists below.
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'del',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];
const ALLOWED_ATTR = ['href', 'title'];

export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false });
  return DOMPurify.sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderArgsHtml(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(
      ([k, v]) => `<div><strong>${escapeHtml(k)}:</strong> ${escapeHtml(JSON.stringify(v))}</div>`,
    )
    .join('');
}

export function renderAuditDetail(event: AuditEvent): string {
  if (event.error) return ` · ${escapeHtml(event.error)}`;
  if (event.result !== undefined) return ` · ${escapeHtml(JSON.stringify(event.result))}`;
  return '';
}

// ─── Toolkit sidebar ────────────────────────────────────────────────────────

const TIER_ORDER: RiskTier[] = ['read', 'write', 'destructive'];
const TIER_LABEL: Record<RiskTier, string> = {
  read: 'Read',
  write: 'Write',
  destructive: 'Destructive',
};

const TOOLS_ALLOWED_TAGS = ['section', 'h3', 'ul', 'li', 'span', 'strong'];
const TOOLS_ALLOWED_ATTR = ['class'];

// Structural subset of FunctionDefinition that this renderer reads. Using a
// subset (rather than `FunctionDefinition<Record<string, unknown>>`) lets the
// heterogeneous tool array — whose elements are `FunctionDefinition<SpecificArgs>`
// for various specific arg shapes — flow in without a cast: each element has
// `name`/`description`/`riskTier`, which is all this function touches. The
// handler's contravariance would otherwise block the assignment.
export interface ToolMeta {
  name: string;
  description: string;
  riskTier: RiskTier;
}

/**
 * Render the toolkit grouped by risk tier. The input is the static tool array
 * (trusted source), but every name/description is still escaped and the whole
 * string is DOMPurify-wrapped as defense-in-depth.
 */
export function renderToolsList(tools: readonly ToolMeta[]): string {
  const byTier: Record<RiskTier, ToolMeta[]> = {
    read: [],
    write: [],
    destructive: [],
  };
  for (const tool of tools) {
    byTier[tool.riskTier].push(tool);
  }
  const html = TIER_ORDER.map((tier) => {
    // Skip empty tiers so the sidebar doesn't render empty headers.
    if (byTier[tier].length === 0) return '';
    const items = byTier[tier]
      .map(
        (t) =>
          `<li><strong class="tool-name">${escapeHtml(t.name)}</strong>` +
          `<span class="tool-desc">${escapeHtml(t.description)}</span></li>`,
      )
      .join('');
    return (
      `<section class="tier-group tier-${tier}">` +
      `<h3>${TIER_LABEL[tier]} <span class="tier-badge">${byTier[tier].length}</span></h3>` +
      `<ul>${items}</ul>` +
      `</section>`
    );
  }).join('');
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: TOOLS_ALLOWED_TAGS,
    ALLOWED_ATTR: TOOLS_ALLOWED_ATTR,
  });
}

// ─── Subagent run cards ──────────────────────────────────────────────────────

// Local allowlist for the live subagent card. Wider than the markdown allowlist
// (adds `div`/`span`/`strong` for the card layout) but still local to this renderer
// — the shared markdown allowlist above is intentionally kept tight and MUST NOT grow.
const ARTIFACT_ALLOWED_TAGS = ['span', 'strong', 'div'];
const ARTIFACT_ALLOWED_ATTR = ['class'];

/** Truncates a string for compact card display (keeps the head + an ellipsis). */
function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * The live state of one subagent run, owned by `SubagentBoard`. Every field is
 * escaped before interpolation and the final string is DOMPurify-wrapped with
 * the local artifact allowlist. The shared markdown allowlist is NOT extended.
 */
export interface SubagentCardState {
  /** The task text the parent passed to spawnSubagent (from the `function_requested` args). */
  task: string;
  /** 'spawning' while in flight, 'done' once the result landed, 'error' if it errored. */
  status: 'spawning' | 'done' | 'error';
  /** Present when status === 'done' (the trimmed SpawnSubagentResult). */
  response?: string;
  truncated?: boolean;
  toolCallsExecuted?: number;
  toolCallsAborted?: number;
  /** Present when status === 'error'. */
  error?: string;
}

export function renderLiveSubagentCard(card: SubagentCardState): string {
  const statusGlyph = card.status === 'spawning' ? '⟳' : card.status === 'done' ? '✓' : '✗';
  const statusLabel =
    card.status === 'spawning' ? 'spawning…' : card.status === 'done' ? 'completed' : 'errored';
  let body: string;
  if (card.status === 'done') {
    const meta =
      `${card.toolCallsExecuted ?? 0} tool call${(card.toolCallsExecuted ?? 0) === 1 ? '' : 's'}` +
      (card.truncated ? ' · truncated' : '') +
      (card.toolCallsAborted ? ` · ${card.toolCallsAborted} aborted` : '');
    body =
      `<span class="meta">${escapeHtml(meta)}</span>` +
      `<div class="subagent-response">${escapeHtml(truncate(card.response ?? ''))}</div>`;
  } else if (card.status === 'error') {
    body = `<span class="meta">${escapeHtml(truncate(card.error ?? ''))}</span>`;
  } else {
    body = `<span class="meta">running the subagent's tool loop…</span>`;
  }
  const html =
    `<strong class="plan-title">Subagent</strong>` +
    `<span class="status status-${escapeHtml(card.status)}">${escapeHtml(statusGlyph)}</span>` +
    `<span class="meta">${escapeHtml(statusLabel)}</span>` +
    `<div class="item-notes">${escapeHtml(truncate(card.task))}</div>` +
    body;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ARTIFACT_ALLOWED_TAGS,
    ALLOWED_ATTR: ARTIFACT_ALLOWED_ATTR,
  });
}

/**
 * Render an append-only error card from a `function_errored` event. Returns null
 * for every other event type — the live subagent card for `spawnSubagent`
 * `function_executed` events is rendered in place by `SubagentBoard` (see
 * subagent-board.ts), not here. The final string is DOMPurify-wrapped with the
 * local artifact allowlist.
 */
export function renderArtifact(event: AuditEvent): string | null {
  if (event.type !== 'function_errored') return null;
  return DOMPurify.sanitize(
    `<strong>${escapeHtml(event.functionName)} errored</strong>` +
      `<span class="meta">${escapeHtml(event.error ?? '')}</span>`,
    { ALLOWED_TAGS: ARTIFACT_ALLOWED_TAGS, ALLOWED_ATTR: ARTIFACT_ALLOWED_ATTR },
  );
}
