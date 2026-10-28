'use client';
import { useEffect, useRef, useState } from 'react';
import {
  ActionCluster,
  Button,
  CopyButton,
  LegacyIconButton as IconButton,
  WorkspaceIcon,
} from '@/components/ui';
import { AttachmentStrip, downloadAttachment, mediaFetch } from './attachments.client';
import type { Attachment } from './attachment-state';

type Row = Record<string, any>;
export type JobArtifact = {
  path: string;
  name: string;
  caption?: string;
  attachmentId?: string;
  kind?: string;
  bytes?: number;
  skipped?: string;
};
/** Text previews read a bounded prefix; the full file is a download. */
const previewBytes = 64 * 1024;

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Stored artifacts reuse the task's attachment rows; a row not yet refreshed falls back to the job's reference. */
export function jobArtifactRows(job: Row, attachments: Attachment[]) {
  const entries: JobArtifact[] = Array.isArray(job.artifacts) ? job.artifacts : [];
  const stored = entries
    .filter((entry) => entry.attachmentId)
    .map(
      (entry): Attachment =>
        attachments.find((row) => row.id === entry.attachmentId) ?? {
          id: entry.attachmentId!,
          taskId: job.taskId,
          runId: job.runId,
          kind: entry.kind || 'file',
          mimeType: '',
          size: entry.bytes || 0,
          name: entry.name,
          caption: entry.caption,
          source: 'job-artifact',
          createdAt: job.finishedAt || job.createdAt || '',
        },
    );
  return {
    media: stored.filter((row) => ['image', 'video'].includes(row.kind)),
    files: stored.filter((row) => !['image', 'video'].includes(row.kind)),
    skipped: entries.filter((entry) => entry.skipped),
  };
}

export function JobArtifacts({ job, attachments = [] }: { job: Row; attachments?: Attachment[] }) {
  const { media, files, skipped } = jobArtifactRows(job, attachments);
  const requested = Array.isArray(job.artifactPaths) && job.artifactPaths.length > 0;
  if (!media.length && !files.length && !skipped.length)
    return requested && ['queued', 'running'].includes(job.status) ? (
      <p className="pw-job-artifacts-pending">Files upload when the job ends</p>
    ) : null;
  return (
    <div className="pw-job-artifacts" role="group" aria-label="Job artifacts">
      {media.length > 0 && <AttachmentStrip rows={media} allRows={media} />}
      {files.length > 0 && (
        <div className="pw-job-artifact-files">
          {files.map((file) => (
            <TextArtifact key={file.id} attachment={file} />
          ))}
        </div>
      )}
      {skipped.length > 0 && (
        <details className="pw-job-artifacts-skipped">
          <summary>
            {skipped.length} file{skipped.length === 1 ? '' : 's'} not returned
          </summary>
          <ul>
            {skipped.map((entry, index) => (
              <li key={`${entry.path}-${index}`}>
                <code>{entry.path}</code> {entry.skipped}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function TextArtifact({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={opener}
        variant="quiet"
        className="pw-job-artifact-file"
        aria-label={`Open ${attachment.name}, ${formatBytes(attachment.size)}`}
        onClick={() => setOpen(true)}
      >
        <WorkspaceIcon name="file" />
        <span className="pw-job-artifact-name">{attachment.caption || attachment.name}</span>
        <span className="pw-job-artifact-size">{formatBytes(attachment.size)}</span>
      </Button>
      {open && (
        <TextArtifactViewer
          attachment={attachment}
          opener={opener.current}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** A text preview in the media viewer's inset modal, with the same header and actions. */
function TextArtifactViewer({
  attachment,
  opener,
  close,
}: {
  attachment: Attachment;
  opener: HTMLButtonElement | null;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string | null>(null),
    [error, setError] = useState(''),
    [wrap, setWrap] = useState(true);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      opener?.focus({ preventScroll: true });
    };
  }, [opener]);
  useEffect(() => {
    let active = true;
    void mediaFetch(`/api/workspace/attachments/${attachment.id}`, {
      headers: { Range: `bytes=0-${previewBytes - 1}` },
    })
      .then((response) => response.text())
      .then((value) => {
        if (active) setText(value);
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [attachment.id]);
  return (
    <dialog
      ref={dialog}
      className="pw-media-viewer pw-media-gallery pw-text-artifact-viewer"
      aria-label={`Text artifact ${attachment.name}`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <header className="pw-media-head">
        <h2>
          <span>{attachment.name}</span>
          <span className="pw-media-caption">
            {[attachment.caption, formatBytes(attachment.size)].filter(Boolean).join(' · ')}
          </span>
        </h2>
        <ActionCluster className="pw-media-actions">
          {text !== null && <CopyButton label="Copy text" text={text} />}
          <IconButton
            icon="wrap"
            label="Wrap lines"
            pressed={wrap}
            onClick={() => setWrap(!wrap)}
          />
          <IconButton
            icon="download"
            label="Download file"
            onClick={() => void downloadAttachment(attachment).catch((e) => setError(e.message))}
          />
          <IconButton icon="close" label="Close preview" shortcut="Esc" onClick={close} />
        </ActionCluster>
      </header>
      {error ? (
        <p role="alert">File unavailable: {error}</p>
      ) : text === null ? (
        <p role="status">Loading file…</p>
      ) : (
        <pre className="pw-job-log pw-text-artifact" data-wrap={wrap} tabIndex={0}>
          {text}
        </pre>
      )}
      {attachment.size > previewBytes && (
        <p className="pw-muted">Showing the first 64 KB. Download the file for the rest.</p>
      )}
    </dialog>
  );
}
