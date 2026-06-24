import { describe, it, expect } from 'vitest';
import {
  renderMarkdown,
  renderArgsHtml,
  renderAuditDetail,
  renderToolsList,
  renderArtifact,
  renderLivePlanCard,
  escapeHtml,
} from '../src/render.js';
import type { AuditEvent, RiskTier } from '@forgewisp/core';
import type { Plan } from '@forgewisp/bundled-tools';

// XSS payload used across every sink. If any sink returns this unsanitized,
// jsdom would parse it and the onerror handler would be attached to the DOM.
const XSS_IMG = '<img src=x onerror=alert(1)>';
const XSS_SCRIPT = '<script>alert("xss")</script>';

function hasExecutablePayload(html: string): boolean {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const hasOnerror = Array.from(tpl.content.querySelectorAll('*')).some((el) =>
    el.hasAttribute('onerror'),
  );
  const hasScript = tpl.content.querySelector('script') !== null;
  return hasOnerror || hasScript;
}

describe('sanitize — renderMarkdown (assistant message + streaming sinks)', () => {
  it('strips onerror handlers from img tags', () => {
    const out = renderMarkdown(XSS_IMG);
    expect(out).not.toContain('onerror');
    expect(hasExecutablePayload(out)).toBe(false);
  });

  it('strips script tags', () => {
    const out = renderMarkdown(`${XSS_SCRIPT}\n\nHello`);
    expect(out).not.toContain('<script');
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).toContain('Hello');
  });

  it('preserves safe markdown', () => {
    const out = renderMarkdown('**bold** and [link](https://example.com)');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('href="https://example.com"');
  });
});

describe('sanitize — renderArgsHtml (confirm dialog args sink)', () => {
  it('escapes attacker-controlled arg values', () => {
    const out = renderArgsHtml({ title: XSS_IMG });
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('escapes attacker-controlled arg keys', () => {
    const out = renderArgsHtml({ '"><img src=x onerror=alert(1)>': 'v' });
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).not.toContain('<img');
  });
});

describe('sanitize — renderAuditDetail (audit log sink)', () => {
  const baseEvent: AuditEvent = {
    id: 'e1',
    timestamp: new Date().toISOString(),
    type: 'function_errored',
    functionName: 'fn',
  };

  it('escapes error strings', () => {
    const out = renderAuditDetail({ ...baseEvent, error: XSS_IMG });
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).toContain('&lt;img');
  });

  it('escapes result JSON', () => {
    const out = renderAuditDetail({ ...baseEvent, type: 'function_executed', result: XSS_IMG });
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).toContain('&lt;img');
  });
});

describe('sanitize — renderToolsList (toolkit sidebar sink)', () => {
  const tools: Array<{ name: string; description: string; riskTier: RiskTier }> = [
    { name: 'createPlan', description: 'a safe tool', riskTier: 'read' },
    { name: XSS_IMG, description: XSS_SCRIPT, riskTier: 'destructive' },
  ];

  it('escapes tool names and descriptions', () => {
    const out = renderToolsList(tools);
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
  });
});

describe('sanitize — renderLivePlanCard (live plan card sink)', () => {
  const xssPlan = {
    id: 'p1',
    title: XSS_IMG,
    createdAt: '2026-01-01T00:00:00.000Z',
    items: [
      {
        id: 'i1',
        title: XSS_SCRIPT,
        status: 'in_progress',
        priority: 'high',
        notes: XSS_IMG,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  } as unknown as Plan;

  it('escapes plan title, item title, and notes', () => {
    const out = renderLivePlanCard(xssPlan);
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('<script');
  });

  it('renders an empty-plan placeholder without items', () => {
    const out = renderLivePlanCard({
      id: 'p2',
      title: 'Empty',
      createdAt: '2026-01-01T00:00:00.000Z',
      items: [],
    });
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).toContain('No items yet');
  });
});

describe('sanitize — renderArtifact (error card sink)', () => {
  const baseEvent: AuditEvent = {
    id: 'e1',
    timestamp: new Date().toISOString(),
    type: 'function_executed',
    functionName: 'createPlan',
  };

  it('escapes function_errored messages', () => {
    const out = renderArtifact({
      ...baseEvent,
      type: 'function_errored',
      error: XSS_IMG,
    });
    expect(out).not.toBeNull();
    expect(hasExecutablePayload(out!)).toBe(false);
    expect(out).toContain('&lt;img');
  });

  it('returns null for function_executed events (plan cards are rendered by PlanBoard)', () => {
    const out = renderArtifact({
      ...baseEvent,
      args: { title: 'x' },
      result: { plan: { id: 'p1', title: 'x', createdAt: '', items: [] } },
    });
    expect(out).toBeNull();
  });

  it('returns null for unrendered event types', () => {
    expect(renderArtifact({ ...baseEvent, type: 'function_requested' })).toBeNull();
  });

  it('returns null for unrecognized tool names', () => {
    expect(renderArtifact({ ...baseEvent, functionName: 'unknownTool' })).toBeNull();
  });
});

describe('sanitize — escapeHtml', () => {
  it('escapes all five HTML metacharacters', () => {
    expect(escapeHtml(`<>"'&`)).toBe('&lt;&gt;&quot;&#39;&amp;');
  });
});
