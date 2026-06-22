import { describe, it, expect } from 'vitest';
import {
  renderMarkdown,
  renderArgsHtml,
  renderAuditDetail,
  renderToolsList,
  renderArtifact,
  escapeHtml,
} from '../src/render.js';
import type { AuditEvent, RiskTier } from '@forgewisp/core';

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
    { name: 'safeTool', description: 'a safe tool', riskTier: 'read' },
    { name: XSS_IMG, description: XSS_SCRIPT, riskTier: 'write' },
  ];

  it('escapes tool names and descriptions', () => {
    const out = renderToolsList(tools);
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
  });
});

describe('sanitize — renderArtifact (artifacts panel sink)', () => {
  const baseEvent: AuditEvent = {
    id: 'e1',
    timestamp: new Date().toISOString(),
    type: 'function_executed',
    functionName: 'speakText',
  };

  it('escapes speakText args', () => {
    const out = renderArtifact({ ...baseEvent, args: { text: XSS_IMG }, result: { spoken: true } });
    expect(out).not.toBeNull();
    expect(hasExecutablePayload(out!)).toBe(false);
    expect(out).toContain('&lt;img');
  });

  it('escapes downloadFile filenames', () => {
    const out = renderArtifact({
      ...baseEvent,
      functionName: 'downloadFile',
      args: { filename: XSS_IMG, content: 'x' },
      result: { downloaded: true, filename: XSS_IMG, sizeBytes: 1 },
    });
    expect(out).not.toBeNull();
    expect(hasExecutablePayload(out!)).toBe(false);
    expect(out).toContain('&lt;img');
  });

  it('builds the geolocation link from numeric coords, never raw strings', () => {
    // A string payload in lat/lng (as if the model lied) must not reach the href
    // attribute or break out of it.
    const out = renderArtifact({
      ...baseEvent,
      functionName: 'getGeolocation',
      args: {},
      // Non-numeric payloads are ignored (num() returns null → renderArtifact
      // returns null), so the link can't be poisoned.
      result: { lat: '"><img src=x onerror=alert(1)', lng: 2, accuracy: 3, timestamp: 1 },
    });
    expect(out).toBeNull();
  });

  it('renders the maps link from real numeric coords', () => {
    const out = renderArtifact({
      ...baseEvent,
      functionName: 'getGeolocation',
      args: {},
      result: { lat: 1.5, lng: 2.5, accuracy: 3, timestamp: 1 },
    });
    expect(out).not.toBeNull();
    expect(hasExecutablePayload(out!)).toBe(false);
    expect(out).toContain('openstreetmap.org');
    expect(out).toContain('1.5000');
    expect(out).toContain('2.5000');
    // No unescaped quote can close the href attribute early.
    expect(out).not.toContain('onerror');
  });

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

  it('returns null for unrendered event types', () => {
    expect(renderArtifact({ ...baseEvent, type: 'function_requested' })).toBeNull();
  });
});

describe('sanitize — escapeHtml', () => {
  it('escapes all five HTML metacharacters', () => {
    expect(escapeHtml(`<>"'&`)).toBe('&lt;&gt;&quot;&#39;&amp;');
  });
});
