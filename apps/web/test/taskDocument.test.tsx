import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MarkdownDocument } from '../src/shared/MarkdownDocument';

it('keeps document-wide references and fenced code while folding actual sections', () => {
  const html = renderToStaticMarkup(<MarkdownDocument text={'# 需求\n[设计][ref]\n\n````md\n```\n# 这是代码\n````\n\n## 方案\n[ref]: https://example.com/design\n'} />);
  expect(html).toContain('href="https://example.com/design"');
  expect(html.match(/<details/g)).toHaveLength(2);
  expect(html).toContain('# 这是代码');
  expect(html).not.toContain('<h1>这是代码');
});
it('does not execute raw HTML or unsafe links and renders GFM tables', () => {
  const html = renderToStaticMarkup(<MarkdownDocument text={'<script>alert(1)</script>\n\n[点击](javascript:alert)\n\n| 目标 | 状态 |\n| --- | --- |\n| 实现 | 待验收 |'} />);
  expect(html).not.toContain('<script>'); expect(html).not.toContain('href="javascript:');
  expect(html).toContain('<table>'); expect(html).toContain('待验收');
});
