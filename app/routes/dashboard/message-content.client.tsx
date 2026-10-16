'use client';
import { memo, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import Markdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

type SyntaxNode = { value?: string; children?: SyntaxNode[] };
const textOf = (node: SyntaxNode): string =>
  node.value ?? node.children?.map(textOf).join('') ?? '';

function CodeBlock({ children, node }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const [copyState, setCopyState] = useState('Copy');
  const code = node?.children.find((child) => child.type === 'element');
  const language =
    code?.type === 'element'
      ? String(code.properties.className || '').match(/language-([\w+-]+)/)?.[1] || 'Code'
      : 'Code';
  const source = node ? textOf(node).replace(/\n$/, '') : '';
  return (
    <div className="pw-code-block">
      <div className="pw-code-heading">
        <span>{language}</span>
        <button
          type="button"
          aria-label="Copy code"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(source);
              setCopyState('Copied');
            } catch {
              setCopyState('Select to copy');
            }
          }}
          onBlur={() => setCopyState('Copy')}
        >
          <span aria-live="polite">{copyState}</span>
        </button>
      </div>
      <pre tabIndex={0} aria-label={`${language} code`}>
        {children}
      </pre>
    </div>
  );
}

const messageComponents: Components = {
  pre: CodeBlock,
  table: ({ children }) => (
    <div className="pw-table-scroll" tabIndex={0} role="region" aria-label="Message table">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) => <img src={src} alt={alt || 'Message image'} loading="lazy" />,
};

/** GFM parsing is memoized so task polling does not reparse unchanged messages. */
export const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  return (
    <div className="pw-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        skipHtml
        components={messageComponents}
      >
        {content}
      </Markdown>
    </div>
  );
});
