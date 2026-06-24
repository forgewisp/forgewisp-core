import { describe, it, expect } from 'vitest';
import {
  renderMarkdown,
  renderArgsHtml,
  renderAuditDetail,
  renderToolsList,
  renderArtifact,
  renderLiveSubagentCard,
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
    const out = renderArgsHtml({ task: XSS_IMG });
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('escapes attacker-controlled arg keys', () => {
    const out = renderArgsHtml({ '"><img src=x onerror=alert(1)>': 'v' });
    expect(hasExecutablePayload(out)).toBe(false);
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
    { name: 'spawnSubagent', description: 'a safe tool', riskTier: 'read' },
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

describe('sanitize — renderLiveSubagentCard (live subagent card sink)', () => {
  it('escapes the task and response of a completed card', () => {
    const out = renderLiveSubagentCard({
      task: XSS_IMG,
      status: 'done',
      response: XSS_SCRIPT,
      truncated: false,
      toolCallsExecuted: 2,
      toolCallsAborted: 0,
    });
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('<script');
  });

  it('escapes the error of an errored card', () => {
    const out = renderLiveSubagentCard({ task: XSS_IMG, status: 'error', error: XSS_SCRIPT });
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).not.toContain('<script');
  });

  it('escapes a spawning card task', () => {
    const out = renderLiveSubagentCard({ task: XSS_IMG, status: 'spawning' });
    expect(hasExecutablePayload(out)).toBe(false);
    expect(out).toContain('&lt;img');
  });
});

describe('sanitize — renderArtifact (error card sink)', () => {
  const baseEvent: AuditEvent = {
    id: 'e1',
    timestamp: new Date().toISOString(),
    type: 'function_executed',
    functionName: 'spawnSubagent',
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

  it('returns null for function_executed events (cards are rendered by SubagentBoard)', () => {
    const out = renderArtifact({
      ...baseEvent,
      args: { task: 'x' },
      result: { response: 'x', truncated: false, toolCallsExecuted: 0, toolCallsAborted: 0 },
    });
    expect(out).toBeNull();
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
