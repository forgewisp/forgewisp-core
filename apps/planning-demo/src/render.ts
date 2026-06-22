import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AuditEvent, RiskTier } from '@forgewisp/core';
import type { Plan, PlanItem, PlanStatus } from '@forgewisp/bundled-tools';

marked.setOptions({ breaks: true, gfm: true });

// Model-controlled markdown is untrusted: it may contain raw HTML. This allowlist
// is deliberately tight (no <img>, no <script>, no event-handler attributes) and
// MUST NOT grow to accommodate the artifacts/tools renderers, which use their own
// local allowlists below.
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
// handler's contravariance would otherwise block the assignment (interfaces like
// `CreatePlanArgs` aren't assignable to `Record<string, unknown>`).
interface ToolMeta {
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
    // Skip empty tiers so the sidebar doesn't render "Write 0" / "Destructive 0"
    // headers when no tools of that tier are registered (the current read-only set).
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

// ─── Artifacts panel ─────────────────────────────────────────────────────────

// Wider than the markdown allowlist (adds `ul`/`li` for plan checklists) but
// still local to this renderer — the shared markdown allowlist above is
// intentionally kept tight and MUST NOT grow.
const ARTIFACT_ALLOWED_TAGS = ['span', 'strong', 'a', 'div', 'ul', 'li'];
const ARTIFACT_ALLOWED_ATTR = ['class', 'href', 'target', 'rel'];

const STATUS_GLYPH: Record<PlanStatus, string> = {
  todo: '◻',
  in_progress: '◑',
  done: '✓',
};

/** Render one plan item as a checklist row (status glyph + title + priority + notes). */
export function renderItem(item: PlanItem): string {
  const glyph = STATUS_GLYPH[item.status] ?? '◻';
  const priority =
    item.priority !== undefined
      ? `<span class="priority priority-${escapeHtml(item.priority)}">${escapeHtml(
          item.priority,
        )}</span>`
      : '';
  const notes = item.notes ? `<span class="item-notes">${escapeHtml(item.notes)}</span>` : '';
  return (
    `<li>` +
    `<span class="status status-${escapeHtml(item.status)}">${escapeHtml(glyph)}</span>` +
    `<span>${escapeHtml(item.title)}</span>` +
    priority +
    notes +
    `</li>`
  );
}

/**
 * Render a live plan card (title + done/count meta + checklist) for a known-good
 * `Plan` owned by `PlanBoard`. Every field is escaped and the final string is
 * DOMPurify-wrapped with the local artifact allowlist (which already includes
 * `ul`/`li` for plan checklists). The shared markdown allowlist above is NOT
 * extended — this renderer uses its own local allowlist only.
 */
export function renderLivePlanCard(plan: Plan): string {
  const items = plan.items;
  const count = items.length;
  const done = items.filter((i) => i.status === 'done').length;
  const list = items.map(renderItem).join('');
  const html =
    `<strong class="plan-title">${escapeHtml(plan.title)}</strong>` +
    `<span class="meta">${done}/${count} done</span>` +
    (count > 0 ? `<ul class="plan-items">${list}</ul>` : `<span class="meta">No items yet</span>`);
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ARTIFACT_ALLOWED_TAGS,
    ALLOWED_ATTR: ARTIFACT_ALLOWED_ATTR,
  });
}

/**
 * Render an append-only error card from a `function_errored` event. Returns null
 * for every other event type — the live plan card for `function_executed` plan
 * events is rendered in place by `PlanBoard` (see plan-board.ts), not here. The
 * final string is DOMPurify-wrapped with the local artifact allowlist.
 */
export function renderArtifact(event: AuditEvent): string | null {
  if (event.type !== 'function_errored') return null;
  return DOMPurify.sanitize(
    `<strong>${escapeHtml(event.functionName)} errored</strong>` +
      `<span class="meta">${escapeHtml(event.error ?? '')}</span>`,
    { ALLOWED_TAGS: ARTIFACT_ALLOWED_TAGS, ALLOWED_ATTR: ARTIFACT_ALLOWED_ATTR },
  );
}
