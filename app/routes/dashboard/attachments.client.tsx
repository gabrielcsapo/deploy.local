'use client';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { getAuth } from './detail/shared';
import { MarkupButton } from './image-markup.client';
import type { Attachment } from './attachment-state';
export const MediaContext = createContext<Attachment[]>([]);
export async function mediaFetch(path: string, init: RequestInit = {}) {
  const auth = getAuth();
  const response = await fetch(path, {
    ...init,
    redirect: 'error',
    headers: {
      ...init.headers,
      ...(auth ? { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token } : {}),
    },
  });
  if (!response.ok)
    throw new Error((await response.json().catch(() => null))?.error || 'Image unavailable');
  return response;
}
export async function uploadImage(taskId: string, file: File, caption = '') {
  return (
    await mediaFetch(
      `/api/workspace/tasks/${taskId}/attachments?name=${encodeURIComponent(file.name)}&caption=${encodeURIComponent(caption)}&operationId=${crypto.randomUUID()}`,
      { method: 'POST', body: file },
    )
  ).json() as Promise<Attachment>;
}
export function AttachmentImage({
  id,
  caption = 'Image',
  attachment,
}: {
  id: string;
  caption?: string;
  attachment?: Attachment;
}) {
  const attachments = useContext(MediaContext);
  const [url, setURL] = useState(''),
    [error, setError] = useState(false),
    [open, setOpen] = useState(false);
  const identity = getAuth();
  useEffect(() => {
    let active = true,
      objectURL = '';
    setURL('');
    setError(false);
    void mediaFetch(`/api/workspace/attachments/${id}/thumbnail`)
      .then((r) => r.blob())
      .then((blob) => {
        if (active) {
          objectURL = URL.createObjectURL(blob);
          setURL(objectURL);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [id, identity?.username, identity?.token]);
  const row = attachment || attachments.find((a) => a.id === id);
  const group = row?.runId
    ? attachments.filter((a) => a.runId === row.runId && a.kind === 'image')
    : row
      ? [row]
      : [];
  return (
    <span className="pw-attachment-image">
      {error ? (
        <span role="status">Image unavailable</span>
      ) : url ? (
        <button
          type="button"
          className="pw-media-open"
          onClick={() => setOpen(true)}
          aria-label={`Open ${caption}`}
        >
          <img src={url} alt={caption} loading="lazy" onError={() => setError(true)} />
        </button>
      ) : (
        <span role="status">Loading image…</span>
      )}
      {open && (
        <ImageViewer initialId={id} group={group} caption={caption} close={() => setOpen(false)} />
      )}
    </span>
  );
}
function ImageViewer({
  initialId,
  group,
  caption,
  close,
}: {
  initialId: string;
  group: Attachment[];
  caption: string;
  close: () => void;
}) {
  const [id, setId] = useState(initialId),
    [url, setURL] = useState(''),
    [error, setError] = useState(''),
    [zoom, setZoom] = useState(1);
  const dialog = useRef<HTMLDialogElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let active = true,
      objectURL = '';
    setURL('');
    setError('');
    setZoom(1);
    void mediaFetch(`/api/workspace/attachments/${id}`)
      .then((r) => r.blob())
      .then((blob) => {
        if (active) {
          objectURL = URL.createObjectURL(blob);
          setURL(objectURL);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [id]);
  const index = group.findIndex((a) => a.id === id),
    row = group[index];
  return (
    <dialog
      ref={dialog}
      className="pw-media-viewer"
      aria-label="Image viewer"
      onCancel={close}
      onClose={close}
    >
      <div className="pw-media-toolbar">
        <Button variant="link" onClick={close}>
          Close
        </Button>
        <Button variant="link" disabled={index <= 0} onClick={() => setId(group[index - 1].id)}>
          Previous
        </Button>
        <Button
          variant="link"
          disabled={index < 0 || index >= group.length - 1}
          onClick={() => setId(group[index + 1].id)}
        >
          Next
        </Button>
        <label>
          Zoom{' '}
          <input
            type="range"
            min="1"
            max="5"
            step="0.25"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
        {row && url && <MarkupButton attachment={row} done={close} />}
        {url && (
          <a href={url} download={row?.name || 'image'}>
            Download
          </a>
        )}
      </div>
      <div
        ref={viewport}
        className="pw-media-viewport"
        onPointerDown={(e) => {
          const el = viewport.current!;
          drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
          el.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) {
            viewport.current!.scrollLeft = drag.current.left + drag.current.x - e.clientX;
            viewport.current!.scrollTop = drag.current.top + drag.current.y - e.clientY;
          }
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {error ? (
          <p role="alert">Image unavailable: {error}</p>
        ) : url ? (
          <img
            src={url}
            draggable={false}
            onError={() => setError('Image could not be decoded')}
            alt={row?.caption || caption}
            style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
          />
        ) : (
          <p role="status">Loading image…</p>
        )}
      </div>
      <p>{row?.caption || caption}</p>
    </dialog>
  );
}
export function AttachmentStrip({
  rows,
  allRows,
  computer = false,
}: {
  rows: Attachment[];
  allRows?: Attachment[];
  computer?: boolean;
}) {
  if (!rows.length) return null;
  const strip = (
    <MediaContext.Provider value={allRows || rows}>
      <div className="pw-media-strip">
        {rows.map((a) =>
          a.kind === 'image' ? (
            <AttachmentImage key={a.id} id={a.id} caption={a.caption || a.name} />
          ) : (
            <AttachmentFile key={a.id} attachment={a} />
          ),
        )}
      </div>
    </MediaContext.Provider>
  );
  return computer ? (
    <details className="pw-computer-media">
      <summary>{rows.length} screenshots from computer use</summary>
      {strip}
    </details>
  ) : (
    strip
  );
}
function AttachmentFile({ attachment }: { attachment: Attachment }) {
  const [error, setError] = useState('');
  return (
    <span>
      <Button
        variant="link"
        onClick={async () => {
          try {
            const blob = await (
              await mediaFetch(`/api/workspace/attachments/${attachment.id}`)
            ).blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = attachment.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (e: any) {
            setError(e.message);
          }
        }}
      >
        {attachment.name}
      </Button>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
