import type React from 'react';
import { safeTaskHref } from '@nexus/core';

const markdownLink = (label: string, href: string) => `[${label.replace(/[\\\[\]]/g, '\\$&')}](<${href.replaceAll('<', '%3C').replaceAll('>', '%3E')}>)`;
export function titleClipboardText(clipboard: Pick<DataTransfer, 'getData'>, selected = ''): string | undefined {
  const text = clipboard.getData('text/plain');
  const url = safeTaskHref(text.trim()) ?? safeTaskHref(clipboard.getData('text/uri-list').split(/\r?\n/).find(line => line && !line.startsWith('#')) ?? '');
  if (url && selected) return markdownLink(selected, url);
  const html = clipboard.getData('text/html');
  if (html && html.length <= 200000) {
    // A detached template keeps scripts and remote resources inert.
    const template = document.createElement('template'); template.innerHTML = html;
    let links = 0;
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (node instanceof Element) {
        if (['SCRIPT', 'STYLE', 'META', 'SVG', 'IFRAME', 'OBJECT'].includes(node.tagName)) return '';
        const href = node.tagName === 'A' ? safeTaskHref(node.getAttribute('href') ?? '') : undefined;
        if (href) { links++; return markdownLink(node.textContent?.trim() || href, href); }
        if (node.tagName === 'BR') return '\n';
      }
      return [...node.childNodes].map(walk).join('');
    };
    const result = walk(template.content);
    if (links && result.trim()) return result;
  }
  // Ordinary text, including a raw URL, keeps the browser's native paste behavior.
  if (!text && url) return url;
}

export function pasteTaskTitle(event: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>, update?: (value: string) => void) {
  const input = event.currentTarget, start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
  const insertion = titleClipboardText(event.clipboardData, input.value.slice(start, end));
  if (insertion === undefined) return;
  event.preventDefault();
  const value = input.value.slice(0, start) + insertion + input.value.slice(end);
  if (update) update(value); else input.value = value;
  requestAnimationFrame(() => { if (input.isConnected) input.setSelectionRange(start + insertion.length, start + insertion.length); });
}
