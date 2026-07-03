import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AuditEvent, RiskTier } from '@forgewisp/core';

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
// heterogeneous `BUNDLED_TOOLS` tuple — whose elements are
// `FunctionDefinition<SpecificArgs>` for various specific arg shapes — flow in
// without a cast: each element has `name`/`description`/`riskTier`, which is all
// this function touches. The handler's contravariance would otherwise block the
// assignment (interfaces like `EvaluateMathArgs` aren't assignable to
// `Record<string, unknown>`).
interface ToolMeta {
  name: string;
  description: string;
  riskTier: RiskTier;
}

/**
 * Render the bundled-tools catalog grouped by risk tier. The input is the static
 * `BUNDLED_TOOLS` array (trusted source), but every name/description is still
 * escaped and the whole string is DOMPurify-wrapped as defense-in-depth.
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

// ─── Artifacts panel ─────────────────────────────────────────────────────────

const ARTIFACT_ALLOWED_TAGS = ['span', 'strong', 'a', 'div', 'img'];
const ARTIFACT_ALLOWED_ATTR = ['class', 'href', 'target', 'rel', 'src', 'alt'];

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function osmHref(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}

/**
 * Render a side-effect artifact card from a `function_executed` audit event, or
 * an error card from a `function_errored` event. Returns null for events we
 * choose not to surface in the panel (their result already appears in the audit
 * log). Every value goes through `escapeHtml`; the geolocation link's `href` is
 * built from `Number(...)` then escaped so no user/model string can break the
 * attribute.
 */
export function renderArtifact(event: AuditEvent): string | null {
  if (event.type === 'function_errored') {
    return DOMPurify.sanitize(
      `<strong>${escapeHtml(event.functionName)} errored</strong>` +
        `<span class="meta">${escapeHtml(event.error ?? '')}</span>`,
      { ALLOWED_TAGS: ARTIFACT_ALLOWED_TAGS, ALLOWED_ATTR: ARTIFACT_ALLOWED_ATTR },
    );
  }
  if (event.type !== 'function_executed') return null;

  const args = event.args ?? {};
  const result = (event.result ?? {}) as Record<string, unknown>;
  let html: string | null = null;

  switch (event.functionName) {
    case 'speakText': {
      const len = num(result.utteranceLength);
      html =
        `<strong>Spoke:</strong> <span>${escapeHtml(str(args.text))}</span>` +
        `<span class="meta">${len ?? 0} chars</span>`;
      break;
    }
    case 'downloadFile': {
      const size = num(result.sizeBytes);
      html =
        `<strong>Downloaded:</strong> <span>${escapeHtml(str(args.filename))}</span>` +
        `<span class="meta">${size ?? 0} B</span>`;
      break;
    }
    case 'getGeolocation': {
      const lat = num(result.lat);
      const lng = num(result.lng);
      if (lat === null || lng === null) return null;
      const href = escapeHtml(osmHref(lat, lng));
      html =
        `<strong>Location:</strong> <span>${lat.toFixed(4)}, ${lng.toFixed(4)}</span>` +
        `<a href="${href}" target="_blank" rel="noopener noreferrer">open in maps</a>`;
      break;
    }
    case 'copyToClipboard': {
      const len = num(result.length);
      html = `<strong>Copied to clipboard:</strong> <span class="meta">${len ?? 0} chars</span>`;
      break;
    }
    case 'getBatteryInfo': {
      if (result.supported !== true) {
        html = `<strong>Battery:</strong> <span class="meta">not supported</span>`;
      } else {
        const level = num(result.level);
        const pct = level === null ? 0 : Math.round(level * 100);
        const charging = result.charging === true ? 'charging' : 'discharging';
        html = `<strong>Battery:</strong> <span>${pct}% ${charging}</span>`;
      }
      break;
    }
    case 'setLocalStorageItem': {
      const size = num(result.sizeBytes);
      html =
        `<strong>localStorage set:</strong> <span>${escapeHtml(str(args.key))}</span>` +
        `<span class="meta">${size ?? 0} B</span>`;
      break;
    }
    case 'removeLocalStorageItem': {
      html = `<strong>localStorage removed:</strong> <span>${escapeHtml(str(args.key))}</span>`;
      break;
    }
    case 'getCurrentTime': {
      html = `<strong>Time:</strong> <span>${escapeHtml(str(result.local))}</span>`;
      break;
    }
    case 'generateQrCode': {
      // The full data URL lives in the audit event's `result` (the executor
      // records it before the loop compacts the LLM-bound copy). Render it as
      // an <img> only after validating it is a PNG data URL — a remote/model
      // string can never break the `src` attribute. Falls back to metadata if
      // the payload is missing or malformed.
      const dataUrl = str(result.dataUrl);
      const version = num(result.version);
      const modules = num(result.modules);
      const meta = `<span class="meta">v${version ?? '?'} · ${modules ?? '?'} modules</span>`;
      if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
        html = `<img class="qr-artifact" src="${escapeHtml(dataUrl)}" alt="Generated QR code" /> ${meta}`;
      } else {
        html = `<strong>QR generated:</strong> ${meta}`;
      }
      break;
    }
    default:
      return null;
  }

  if (html === null) return null;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ARTIFACT_ALLOWED_TAGS,
    ALLOWED_ATTR: ARTIFACT_ALLOWED_ATTR,
  });
}
