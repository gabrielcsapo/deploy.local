'use client';
import { createContext, memo, useContext, useMemo } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CopyButton } from '@/components/ui';
import { AttachmentImage, MediaContext } from './attachments.client';
import type { Attachment } from './attachment-state';
import {
  attachmentForPath,
  isLocalFilePath,
  rewriteMessagePaths,
  taskFileReference,
  viewableAttachment,
} from './task-file-link';
import type { TaskFileContext, TaskFileReference } from './task-file-link';

type SyntaxNode = { value?: string; children?: SyntaxNode[] };
const textOf = (node: SyntaxNode): string =>
  node.value ?? node.children?.map(textOf).join('') ?? '';

function CodeBlock({ children, node }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
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
        <CopyButton text={source} label="Copy code" size="compact" />
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

function readablePath(href: string | undefined) {
  try {
    return decodeURI(href || '').replace(/^file:\/\/(?:localhost)?/i, '');
  } catch {
    return href;
  }
}

function MessageLink({ href, children }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const fileLinks = useContext(FileLinksContext);
  const attachments = useContext(MediaContext);
  const reference = fileLinks ? taskFileReference(href, fileLinks.task) : null;
  // Media the agent attached is held by the dashboard even though its path is on another
  // computer; everything else outside this task is shown, but not as a dead link.
  if (!reference && isLocalFilePath(href)) {
    const attachment = viewableAttachment(attachmentForPath(href, attachments));
    if (attachment) return <AttachmentImage id={attachment.id} caption={attachment.name} />;
    return <code title={readablePath(href)}>{children}</code>;
  }
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

// `file://` links reach MessageLink, which opens them in the task or shows them as code; they are
// never followed. Every other URL keeps react-markdown's safe-scheme filter.
const keepFileLinks = (url: string) => (/^file:\/\//i.test(url) ? url : defaultUrlTransform(url));

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
  // Worker-disk paths become in-task links, attachment links or inline code before parsing.
  const source = useMemo(
    () => rewriteMessagePaths(content, { task: fileLinks?.task, attachments }),
    [content, fileLinks?.task, attachments],
  );
  const document = (
    <div className="pw-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        skipHtml
        urlTransform={keepFileLinks}
        components={messageComponents}
      >
        {source}
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
