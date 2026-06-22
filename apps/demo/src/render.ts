import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AuditEvent } from '@forgewisp/core';

marked.setOptions({ breaks: true, gfm: true });

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

export function renderTaskList(tasks: Array<{ id: number; title: string; done: boolean }>): string {
  return DOMPurify.sanitize(
    tasks
      .map(
        (t) =>
          `<li class="${t.done ? 'done' : ''}">
            <span class="task-id">#${t.id}</span>
            <span class="task-title">${escapeHtml(t.title)}</span>
            ${t.done ? '<span class="badge">Done</span>' : ''}
          </li>`,
      )
      .join(''),
  );
}
