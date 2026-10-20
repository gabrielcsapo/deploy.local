'use client';
import { createContext, memo, useContext, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import Markdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { AttachmentImage, MediaContext } from './attachments.client';
import type { Attachment } from './attachment-state';
import { taskFileReference } from './task-file-link';
import type { TaskFileContext, TaskFileReference } from './task-file-link';

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

/** Links into the task workspace open the Changes view; the parent keeps this object stable. */
export interface MessageFileLinks {
  task: TaskFileContext;
  open: (reference: TaskFileReference) => void;
}
const FileLinksContext = createContext<MessageFileLinks | undefined>(undefined);

function MessageLink({ href, children }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const fileLinks = useContext(FileLinksContext);
  const reference = fileLinks ? taskFileReference(href, fileLinks.task) : null;
  if (!fileLinks || !reference)
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  return (
    <a
      href={href}
      className="pw-file-link"
      title={`Show ${reference.path}${reference.line ? ` line ${reference.line}` : ''} in Changes`}
      onClick={(event) => {
        event.preventDefault();
        fileLinks.open(reference);
      }}
    >
      {children}
    </a>
  );
}

const messageComponents: Components = {
  pre: CodeBlock,
  table: ({ children }) => (
    <div className="pw-table-scroll" tabIndex={0} role="region" aria-label="Message table">
      <table>{children}</table>
    </div>
  ),
  a: MessageLink,
  img: ({ src, alt }) =>
    typeof src === 'string' && /^\/api\/workspace\/attachments\/[^/]+$/.test(src) ? (
      <AttachmentImage id={src.split('/').at(-1)!} caption={alt || 'Message image'} />
    ) : (
      <img src={src} alt={alt || 'Message image'} loading="lazy" />
    ),
};

/** GFM parsing is memoized so task polling does not reparse unchanged messages. */
export const MessageContent = memo(function MessageContent({
  content,
  fileLinks,
  attachments,
}: {
  content: string;
  fileLinks?: MessageFileLinks;
  attachments?: Attachment[];
}) {
  const document = (
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
  const markdown = attachments ? (
    <MediaContext.Provider value={attachments}>{document}</MediaContext.Provider>
  ) : (
    document
  );
  return fileLinks ? (
    <FileLinksContext.Provider value={fileLinks}>{markdown}</FileLinksContext.Provider>
  ) : (
    markdown
  );
});
