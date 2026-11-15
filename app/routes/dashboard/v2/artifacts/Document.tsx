'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Action, Banner, DetailTemplate, Dialog, Field, Icon, Skeleton } from '@/components/ui';
import {
  blocksMarkdown,
  changedBlocks,
  changedWhen,
  documentBlocks,
  documentBody,
  type DocumentBlock,
} from '../../../../../shared/v2/artifacts';
import { request } from '../projects/data';
import { designApi } from '../design/model';
import { galleryPath } from './model';
import { changedLine, inlineHtml, readBlocks, type DocumentPage } from './document-model';
import '../design/review.css';

/** Blocks as page elements; consecutive list items share one list. */
function blocksHtml(blocks: DocumentBlock[]) {
  let html = '';
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.kind === 'bullet' || block.kind === 'number') {
      const tag = block.kind === 'bullet' ? 'ul' : 'ol';
      html += `<${tag}>`;
      for (; index < blocks.length && blocks[index].kind === block.kind; index++)
        html += `<li>${inlineHtml(blocks[index].text)}</li>`;
      index--;
      html += `</${tag}>`;
    } else if (block.kind === 'heading')
      html += `<h${block.level}>${inlineHtml(block.text)}</h${block.level}>`;
    else if (block.kind === 'code')
      html += `<pre><code>${inlineHtml(block.text).replace(/<\/?[^>]+>/g, '')}</code></pre>`;
    else html += `<p>${inlineHtml(block.text)}</p>`;
  }
  return html;
}

/** The page's block elements in the order readBlocks reads them. */
function blockElements(root: HTMLElement) {
  const found: HTMLElement[] = [];
  for (const child of Array.from(root.children) as HTMLElement[]) {
    const name = child.nodeName.toLowerCase();
    if (name === 'ul' || name === 'ol')
      found.push(...(Array.from(child.children) as HTMLElement[]));
    else if (['h2', 'h3', 'pre'].includes(name) || child.textContent?.trim()) found.push(child);
  }
  return found;
}

function BranchIcon() {
  return <Icon name="branch" size={13} />;
}

/** A small icon drawn as the board draws it, for the formatting bar. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const tools: { label: string; run: () => void; glyph: ReactNode }[] = [
  {
    label: 'Bold',
    run: () => document.execCommand('bold'),
    glyph: <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />,
  },
  {
    label: 'Italic',
    run: () => document.execCommand('italic'),
    glyph: <path d="M10 5h7M7 19h7M14 5l-4 14" />,
  },
  {
    label: 'Bulleted list',
    run: () => document.execCommand('insertUnorderedList'),
    glyph: (
      <>
        <path d="M9 6h11M9 12h11M9 18h11" />
        <circle cx="4.5" cy="6" r="1" />
        <circle cx="4.5" cy="12" r="1" />
        <circle cx="4.5" cy="18" r="1" />
      </>
    ),
  },
  {
    label: 'Numbered list',
    run: () => document.execCommand('insertOrderedList'),
    glyph: <path d="M10 6h10M10 12h10M10 18h10M4 5h1v4M4 15h2l-2 3h2" />,
  },
  {
    label: 'Link',
    run: () => {
      const selected = window.getSelection()?.toString().trim() ?? '';
      const href = /^(https?:|mailto:|\/)/.test(selected) ? selected : window.prompt('Link');
      if (href) document.execCommand('createLink', false, href);
    },
    glyph: (
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    ),
  },
  {
    label: 'Code',
    run: () => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const code = document.createElement('code');
      code.textContent = range.toString();
      range.deleteContents();
      range.insertNode(code);
    },
    glyph: <path d="M8 8l-4 4 4 4M16 8l4 4-4 4" />,
  },
];

/**
 * A document as a page under Artifacts, in the reading column. Edit starts a branch for it; then
 * the page is typed in, each change is saved to the branch, and Propose asks for review.
 */
export function DocumentView({
  projectId,
  artifact,
  initialRef,
}: {
  projectId: string;
  artifact: string;
  initialRef: string | null;
}) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact)}/document`;
  const [doc, setDoc] = useState<DocumentPage>();
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [pending, setPending] = useState(false);
  const [changed, setChanged] = useState(0);
  const [starting, setStarting] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const latest = useRef<{ branch: string | null; commit: string | null }>({
    branch: null,
    commit: null,
  });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(
    async (ref: string | null) => {
      const next = await request<DocumentPage>(
        ref ? `${path}?ref=${encodeURIComponent(ref)}` : path,
      );
      latest.current = { branch: next.branch, commit: next.commit };
      setDoc(next);
      return next;
    },
    [path],
  );
  useEffect(() => {
    load(initialRef).catch((failure) => setError((failure as Error).message));
  }, [load, initialRef]);

  const editing = Boolean(doc?.branch);
  const mainBlocks = doc?.main ? documentBlocks(documentBody(doc.main)) : [];
  // Mark each block that differs from main, and count them for the page's line.
  const mark = useCallback(() => {
    const root = editor.current;
    if (!root) return;
    const flags = changedBlocks(mainBlocks, readBlocks(root));
    blockElements(root).forEach((element, index) => {
      if (flags[index]) element.dataset.changed = '';
      else delete element.dataset.changed;
    });
    setChanged(flags.filter(Boolean).length);
    // mainBlocks is derived from doc.main, which only changes with the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.main]);
  // The page's text goes in once when editing starts; after that the browser owns it, so typing
  // never moves the cursor.
  const filled = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!editing || !doc || !editor.current || filled.current === doc.artifact) return;
    filled.current = doc.artifact;
    const blocks = documentBlocks(documentBody(doc.text));
    editor.current.innerHTML = blocksHtml(blocks) || '<p><br></p>';
    mark();
  }, [editing, doc, mark]);

  const save = useCallback(() => {
    const root = editor.current;
    if (!root || !doc) return;
    const text = blocksMarkdown(doc.title, readBlocks(root));
    saving.current = saving.current.then(async () => {
      try {
        const saved = await request<{ branch: string; commit: string }>(path, {
          method: 'PUT',
          body: JSON.stringify({
            branch: latest.current.branch,
            expect: latest.current.commit,
            text,
          }),
        });
        latest.current = saved;
        setSaveError('');
        const next = await request<DocumentPage>(`${path}?ref=${encodeURIComponent(saved.branch)}`);
        setDoc((current) =>
          current
            ? { ...current, commit: next.commit, edits: next.edits, review: next.review }
            : next,
        );
      } catch (failure) {
        setSaveError((failure as Error).message);
      } finally {
        setPending(false);
      }
    });
  }, [doc, path]);
  const typed = () => {
    mark();
    setPending(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 600);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const startEditing = async () => {
    if (!doc) return;
    setStarting(true);
    try {
      // Edit starts a branch: saving the text as it is makes artifact/<name> from main.
      const started = await request<{ branch: string; commit: string }>(path, {
        method: 'PUT',
        body: JSON.stringify({ text: doc.text }),
      });
      await load(started.branch);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setStarting(false);
    }
  };

  // Propose: the same request a design's branch makes.
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalTitle, setProposalTitle] = useState('');
  const [proposalSummary, setProposalSummary] = useState('');
  const [proposalError, setProposalError] = useState('');
  const [proposing, setProposing] = useState(false);
  const sendProposal = async () => {
    if (!doc?.branch || !proposalTitle.trim() || !proposalSummary.trim()) return;
    setProposing(true);
    try {
      clearTimeout(timer.current);
      await saving.current;
      await request(`${designApi(projectId, artifact)}/propose`, {
        method: 'POST',
        body: JSON.stringify({
          ref: doc.branch,
          title: proposalTitle.trim(),
          summary: proposalSummary.trim(),
        }),
      });
      setProposalOpen(false);
      setProposalError('');
      const next = await request<DocumentPage>(`${path}?ref=${encodeURIComponent(doc.branch)}`);
      setDoc((current) =>
        current ? { ...current, review: next.review, edits: next.edits } : next,
      );
    } catch (failure) {
      setProposalError((failure as Error).message);
    } finally {
      setProposing(false);
    }
  };
  const inReview = Boolean(
    doc?.review &&
    doc.branch &&
    doc.commit &&
    doc.review.id.endsWith(`:${doc.branch.replaceAll('/', '~')}:${doc.commit.slice(0, 12)}`),
  );

  const crumbTitle = doc?.title || artifact;
  if (error && !doc)
    return (
      <DetailTemplate title={crumbTitle} parent={{ label: 'Artifacts', href: galleryPath }}>
        <Banner kind="danger" title={error} />
      </DetailTemplate>
    );
  if (!doc)
    return (
      <DetailTemplate title={crumbTitle} parent={{ label: 'Artifacts', href: galleryPath }}>
        <Skeleton rows={6} label="Loading the document" />
      </DetailTemplate>
    );
  const blocks = documentBlocks(documentBody(doc.text));
  return (
    <DetailTemplate
      title={crumbTitle}
      parent={{ label: 'Artifacts', href: galleryPath }}
      className="ad-page"
      actions={
        editing ? (
          <>
            <span className="dl-meta ad-branch">
              <BranchIcon />
              {doc.branch} ·{' '}
              {doc.edits ? `${doc.edits} edit${doc.edits === 1 ? '' : 's'}` : 'no edits yet'}
            </span>
            <Action
              variant="primary"
              disabled={inReview || proposing}
              onClick={() => setProposalOpen(true)}
            >
              {inReview ? 'In review' : 'Propose'}
            </Action>
          </>
        ) : (
          <Action loading={starting} onClick={() => void startEditing()}>
            Edit
          </Action>
        )
      }
    >
      {editing && (
        <div className="ad-bar" role="toolbar" aria-label="Formatting">
          {tools.map((tool) => (
            <button
              key={tool.label}
              type="button"
              className="dl-icon-btn"
              aria-label={tool.label}
              title={tool.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                editor.current?.focus();
                tool.run();
                typed();
              }}
            >
              <Glyph>{tool.glyph}</Glyph>
            </button>
          ))}
          <span className="dl-meta ad-saved" role="status">
            {saveError || (pending ? '' : 'Saved to the branch')}
          </span>
        </div>
      )}
      <article className={`ad${editing ? ' editing' : ''}`}>
        <h1>{doc.title}</h1>
        <span className="dl-meta">
          {editing
            ? [doc.project, 'Document', changed ? changedLine(changed) : null]
                .filter(Boolean)
                .join(' · ')
            : `${doc.project} · Document · on main · changed ${changedWhen(doc.changedAt)}`}
        </span>
        {editing ? (
          <div
            ref={editor}
            className="ad-body"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label={doc.title}
            onInput={typed}
          />
        ) : (
          <div className="ad-body" dangerouslySetInnerHTML={{ __html: blocksHtml(blocks) }} />
        )}
      </article>
      <Dialog
        className="dl-propose-dialog"
        open={proposalOpen}
        onClose={() => !proposing && setProposalOpen(false)}
        title="Propose for review"
        actions={
          <>
            <Action disabled={proposing} onClick={() => setProposalOpen(false)}>
              Cancel
            </Action>
            <Action
              variant="primary"
              disabled={proposing || !proposalTitle.trim() || !proposalSummary.trim()}
              onClick={() => void sendProposal()}
            >
              Propose
            </Action>
          </>
        }
      >
        <form
          className="dl-propose-form"
          onSubmit={(event) => {
            event.preventDefault();
            void sendProposal();
          }}
        >
          <Field
            label="What is this?"
            required
            maxLength={200}
            value={proposalTitle}
            onChange={(event) => setProposalTitle(event.target.value)}
          />
          <label>
            What changed, and why?
            <textarea
              className="dl-textarea"
              required
              maxLength={4000}
              value={proposalSummary}
              onChange={(event) => setProposalSummary(event.target.value)}
            />
          </label>
          <p className="dl-meta">The reviewer reads this first.</p>
          {proposalError && <p role="alert">{proposalError}</p>}
        </form>
      </Dialog>
    </DetailTemplate>
  );
}
