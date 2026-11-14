'use client';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Skeleton, Action, Banner, Icon, Seg } from '@/components/ui';
import { getAuth } from '../../detail/shared';
import { authenticatedFetch } from '../data/hooks';
import { formatTime } from '../data/time';
import { workspaceCommand } from './api';
import { fileMarkdown, fileSize, safeUrl } from './description';
import { descriptionWithoutChecks } from './presentation';
import type { PullFile, TaskPull } from './types';

// A pull request's description, on the task's Changes tab. Any file can be dropped, pasted or
// attached; it uploads at once and its Markdown link goes in at the cursor. Files render by
// what they are: images and video inline, text as a preview, PDFs open, the rest download.

function typeLabel(file: PullFile) {
  const extension = file.name.includes('.') ? file.name.split('.').at(-1)!.toUpperCase() : '';
  return file.kind === 'pdf' ? 'PDF' : extension || 'File';
}

function TextPreview({ file }: { file: PullFile }) {
  const [text, setText] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    authenticatedFetch(file.url)
      .then((response) => (response.ok ? response.text() : Promise.reject()))
      .then((value) => live && setText(value.slice(0, 200_000)))
      .catch(() => live && setText(''));
    return () => {
      live = false;
    };
  }, [file.url]);
  const lines = text?.split('\n') || [];
  return (
    <div className="dl-desc-log">
      <div className="dl-desc-log-head">
        <Icon name="file" size={14} />
        <span>{file.name}</span>
        <span className="dl-meta">
          {fileSize(file.bytes)}
          {text ? ` · ${lines.length} lines` : ''}
        </span>
        {lines.length > 6 && (
          <button type="button" className="dl-desc-link" onClick={() => setAll(!all)}>
            {all ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
      {text === null ? (
        <div className="dl-desc-log-body">
          <Skeleton block label="Loading" />
        </div>
      ) : (
        <pre>{(all ? lines : lines.slice(0, 6)).join('\n')}</pre>
      )}
    </div>
  );
}
function FileCard({ file }: { file: PullFile }) {
  return (
    <div className="dl-desc-card">
      <span className="dl-desc-card-icon">
        <Icon name="file" size={18} />
      </span>
      <span className="dl-t">
        <span>{file.name}</span>
        <span>
          {typeLabel(file)} · {fileSize(file.bytes)}
        </span>
      </span>
      {file.kind === 'pdf' ? (
        <a className="dl-btn quiet" href={file.url} target="_blank" rel="noopener">
          Open
        </a>
      ) : (
        <a className="dl-btn secondary" href={file.url} download={file.name}>
          <Icon name="download" size={14} />
          Download
        </a>
      )}
    </div>
  );
}
function Figure({ file, alt }: { file: PullFile; alt?: string }) {
  return (
    <figure className="dl-desc-figure">
      <a href={file.url} target="_blank" rel="noopener">
        <img src={file.url} alt={alt || file.name} loading="lazy" />
      </a>
      <figcaption>
        <Icon name="image" size={14} />
        <span>
          {file.name}
          {alt && alt !== file.name ? ` · ${alt}` : ''}
        </span>
      </figcaption>
    </figure>
  );
}
function Rendered({ body, files }: { body: string; files: PullFile[] }) {
  const byUrl = new Map(files.map((file) => [file.url, file]));
  const block = (file: PullFile, alt?: string) =>
    file.kind === 'image' ? (
      <Figure file={file} alt={alt} />
    ) : file.kind === 'video' ? (
      <video className="dl-desc-video" controls preload="metadata" src={file.url}>
        <a href={file.url}>{file.name}</a>
      </video>
    ) : file.kind === 'text' ? (
      <TextPreview file={file} />
    ) : (
      <FileCard file={file} />
    );
  return (
    <div className="dl-desc-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          // Files render as blocks, so paragraphs must be able to hold them.
          p: ({ children }) => <div className="dl-desc-p">{children}</div>,
          img: ({ src, alt }) => {
            const file = typeof src === 'string' ? byUrl.get(src) : undefined;
            if (file) return block(file, alt);
            // Images from elsewhere stay links, so opening a description never calls out.
            return src ? (
              <a href={String(src)} target="_blank" rel="noopener noreferrer">
                {alt || String(src)}
              </a>
            ) : null;
          },
          a: ({ href, children }) => {
            const file = href ? byUrl.get(href) : undefined;
            if (file) return block(file);
            return href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <>{children}</>
            );
          },
        }}
      >
        {body}
      </Markdown>
    </div>
  );
}

type Upload = { key: string; name: string; size: number; progress: number; error?: string };
function upload(pullId: string, file: File, onProgress: (value: number) => void) {
  return new Promise<PullFile>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/pulls/${encodeURIComponent(pullId)}/files`);
    request.withCredentials = true;
    const auth = getAuth();
    if (auth) {
      request.setRequestHeader('x-deploy-username', auth.username);
      request.setRequestHeader('x-deploy-token', auth.token);
    }
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    request.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'file'));
    request.upload.onprogress = (event) =>
      event.lengthComputable && onProgress(event.loaded / event.total);
    request.onload = () => {
      let body: any = {};
      try {
        body = JSON.parse(request.responseText);
      } catch {
        body = {};
      }
      if (request.status === 201 && body.file) resolve(body.file);
      else reject(new Error(body.error || `Upload failed (${request.status})`));
    };
    request.onerror = () => reject(new Error('Upload failed. Check the connection.'));
    request.send(file);
  });
}

export function PullDescription({
  pull,
  projectId,
  drafter,
  onSaved,
}: {
  pull: TaskPull;
  projectId: string;
  /** Who drafted it, for "Drafted by Codex from checkpoint 3". */
  drafter: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pull.body || '');
  const [mode, setMode] = useState('write');
  const [files, setFiles] = useState<PullFile[]>(pull.files || []);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const readOnly = pull.status === 'merged';
  useEffect(() => setFiles(pull.files || []), [pull.files]);
  useEffect(() => {
    if (!editing) setDraft(pull.body || '');
  }, [pull.body, editing]);

  function insert(text: string) {
    setDraft((current) => {
      const at = field.current?.selectionStart ?? current.length;
      const before = current.slice(0, at);
      const gap = before && !before.endsWith('\n') ? '\n' : '';
      return `${before}${gap}${text}\n${current.slice(at)}`;
    });
  }
  function add(list: FileList | File[]) {
    if (readOnly) return;
    setEditing(true);
    setMode('write');
    for (const file of Array.from(list)) {
      const key = crypto.randomUUID();
      setUploads((items) => [...items, { key, name: file.name, size: file.size, progress: 0 }]);
      const update = (patch: Partial<Upload>) =>
        setUploads((items) =>
          items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
        );
      upload(pull.id, file, (progress) => update({ progress }))
        .then((stored) => {
          setFiles((items) => [...items, stored]);
          insert(fileMarkdown(stored));
          setUploads((items) => items.filter((item) => item.key !== key));
        })
        .catch((failure) => update({ error: failure.message }));
    }
  }
  async function save() {
    setSaving(true);
    setError('');
    try {
      await workspaceCommand(
        authenticatedFetch,
        `/projects/${encodeURIComponent(projectId)}/pulls/${encodeURIComponent(pull.id)}/update`,
        { revision: pull.revision, body: draft },
      );
      setEditing(false);
      setUploads([]);
      onSaved();
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  }
  const dragFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  let meta: ReactNode = pull.bodyEditedAt
    ? `Edited by ${pull.bodyEditedBy} · ${formatTime(pull.bodyEditedAt)}`
    : drafter;
  if (editing && !pull.bodyEditedAt) meta = `${drafter} · edit anything`;
  return (
    <section
      className="dl-desc"
      aria-label="Description"
      onDragEnter={(event) => {
        if (readOnly || !dragFiles(event)) return;
        event.preventDefault();
        setDragging(event.dataTransfer.items.length || 1);
      }}
      onDragOver={(event) => {
        if (readOnly || !dragFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(0);
      }}
      onDrop={(event) => {
        if (readOnly || !event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(0);
        add(event.dataTransfer.files);
      }}
    >
      <div className="dl-desc-head">
        <span className="dl-desc-title">Description</span>
        {editing && (
          <Seg
            label="Description view"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'write', label: 'Write' },
              { value: 'preview', label: 'Preview' },
            ]}
          />
        )}
        <span className="dl-meta">{meta}</span>
        {!editing && !readOnly && (
          <Action variant="quiet" onClick={() => setEditing(true)}>
            Edit
          </Action>
        )}
      </div>
      {!editing ? (
        pull.body?.trim() ? (
          <Rendered body={descriptionWithoutChecks(pull.body)} files={files} />
        ) : (
          <p className="dl-meta dl-desc-empty">No description yet.</p>
        )
      ) : (
        <>
          {mode === 'write' ? (
            <>
              <label className="dl-sr" htmlFor={`desc-${pull.id}`}>
                Description
              </label>
              <textarea
                id={`desc-${pull.id}`}
                ref={field}
                className="dl-desc-text"
                value={draft}
                maxLength={50000}
                onChange={(event) => setDraft(event.target.value)}
                onPaste={(event) => {
                  if (!event.clipboardData.files.length) return;
                  event.preventDefault();
                  add(event.clipboardData.files);
                }}
              />
            </>
          ) : (
            <Rendered body={draft} files={files} />
          )}
          {!!uploads.length && (
            <div className="dl-desc-chips">
              {uploads.map((item) => (
                <span
                  className="dl-desc-chip"
                  key={item.key}
                  data-error={item.error ? '' : undefined}
                >
                  <Icon name="file" size={14} />
                  {item.name}
                  {item.error ? (
                    <span className="dl-meta">{item.error}</span>
                  ) : (
                    <>
                      <span className="dl-desc-bar">
                        <i style={{ width: `${Math.round(item.progress * 100)}%` }} />
                      </span>
                      <span className="dl-meta">
                        {item.progress < 1
                          ? `${Math.round(item.progress * 100)}%`
                          : fileSize(item.size)}
                      </span>
                    </>
                  )}
                </span>
              ))}
            </div>
          )}
          {!!dragging && (
            <div className="dl-desc-drop">
              <Icon name="download" size={16} />
              Drop to add {dragging} {dragging === 1 ? 'file' : 'files'} to the description
            </div>
          )}
          {error && <Banner kind="danger" title={error} />}
          <div className="dl-desc-foot">
            <Action onClick={() => picker.current?.click()}>
              <Icon name="plus" size={14} />
              Attach files
            </Action>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) add(event.target.files);
                event.target.value = '';
              }}
            />
            <span className="dl-meta">
              Drop, paste or attach any file. Images, video and PDFs show inline; anything else is a
              download.
            </span>
            <span className="dl-desc-actions">
              <Action
                variant="quiet"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setDraft(pull.body || '');
                  setUploads([]);
                  setError('');
                }}
              >
                Cancel
              </Action>
              <Action
                variant="primary"
                loading={saving}
                disabled={uploads.some((item) => !item.error)}
                onClick={() => void save()}
              >
                Save description
              </Action>
            </span>
          </div>
        </>
      )}
      {!editing && !!dragging && (
        <div className="dl-desc-drop">
          <Icon name="download" size={16} />
          Drop to add {dragging} {dragging === 1 ? 'file' : 'files'} to the description
        </div>
      )}
    </section>
  );
}
