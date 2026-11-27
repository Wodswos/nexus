import React, { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface HtmlNode { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HtmlNode[] }
/** Group already-parsed HTML nodes: references and fenced code keep full-document semantics. */
function foldSections() {
  return (tree: unknown) => {
    const root = tree as HtmlNode;
    if (!root.children) return;
    const output: HtmlNode[] = [];
    let section: HtmlNode | undefined;
    for (const child of root.children) {
      if (child.type === 'element' && ['h1', 'h2'].includes(child.tagName ?? '')) {
        section = { type: 'element', tagName: 'details', properties: { open: true, className: ['document-section'] }, children: [
          { type: 'element', tagName: 'summary', properties: {}, children: [child] },
        ] };
        output.push(section);
      } else (section?.children ?? output).push(child);
    }
    root.children = output;
  };
}
export const MarkdownDocument = memo(function MarkdownDocument({ text }: { text: string }) {
  return <div className="task-markdown break-words text-[14px] leading-7 [overflow-wrap:anywhere]">
    {!text ? <p className="text-muted">暂无正文</p> : <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[foldSections]} components={{
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      img: ({ src, alt }) => <a href={src} target="_blank" rel="noopener noreferrer">{alt || '查看图片'}</a>,
      table: ({ node: _node, ...props }) => <div className="overflow-x-auto"><table {...props} /></div>,
    }}>{text}</Markdown>}
  </div>;
});
