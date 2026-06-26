import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AuditEvent, RiskTier } from '@forgewisp/core';

marked.setOptions({ breaks: true, gfm: true });

// Model-controlled markdown is untrusted: it may contain raw HTML. This allowlist
// is deliberately tight (no <img>, no <script>, no event-handler attributes) and
// MUST NOT grow to accommodate the tools renderer, which uses its own local
// allowlist below.
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
// subset lets the adapted MCP `FunctionDefinition[]` (whose elements carry
// `name`/`description`/`riskTier`) flow in without a cast: each element has
// exactly the fields this function touches.
interface ToolMeta {
  name: string;
  description: string;
  riskTier: RiskTier;
}

/**
 * Render the connected MCP tools grouped by risk tier. Tool names/descriptions
 * originate from a remote MCP server (untrusted-ish), so every value is escaped
 * and the whole string is DOMPurify-wrapped as defense-in-depth.
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
