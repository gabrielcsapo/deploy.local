'use client';
import { IconLink } from '@/components/ui';
import { IconButton, ActionCluster } from '@/components/ui';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { getAuth } from './detail/shared';
import { MarkupButton } from './image-markup.client';
import { VideoPoster } from './video-media.client';
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
export function uploadImage(
  taskId: string,
  file: File,
  options: {
    caption?: string;
    signal?: AbortSignal;
    progress?: (loaded: number, total: number) => void;
  } = {},
): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(
      'POST',
      `/api/workspace/tasks/${taskId}/attachments?name=${encodeURIComponent(file.name)}&caption=${encodeURIComponent(options.caption || '')}&operationId=${crypto.randomUUID()}`,
    );
    const auth = getAuth();
    if (auth) {
      request.setRequestHeader('x-deploy-username', auth.username);
      request.setRequestHeader('x-deploy-token', auth.token);
    }
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    const abort = () => request.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    request.onloadend = () => options.signal?.removeEventListener('abort', abort);
    request.upload.onprogress = (event) =>
      options.progress?.(event.loaded, event.total || file.size);
    request.onload = () => {
      try {
        const result = JSON.parse(request.responseText);
        if (request.status < 200 || request.status >= 300)
          throw new Error(result.error || 'Upload failed');
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () => reject(new Error('Upload failed'));
    request.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    if (options.signal?.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'));
      return;
    }
    request.send(file);
  });
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
  const row = attachment || attachments.find((a) => a.id === id);
  useEffect(() => {
    let active = true,
      objectURL = '';
    setURL('');
    setError(false);
    if (row?.kind === 'video') return;
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
  }, [id, row?.kind, identity?.username, identity?.token]);
  const group = row?.runId
    ? attachments.filter((a) => a.runId === row.runId && ['image', 'video'].includes(a.kind))
    : row
      ? [row]
      : [];
  return (
    <span className="pw-attachment-image">
      {row?.kind === 'video' ? (
        <VideoPoster attachment={row} open={() => setOpen(true)} />
      ) : error ? (
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
  const index = group.findIndex((a) => a.id === id),
    row = group[index];
  const isVideo = row?.kind === 'video';
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
    if (isVideo) {
      setURL(`/api/workspace/attachments/${id}`);
      return;
    }
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
  }, [id, isVideo]);
  return (
    <dialog
      ref={dialog}
      className="pw-media-viewer"
      aria-label="Media viewer"
      onCancel={close}
      onClose={close}
    >
      {/* Related utilities are end-aligned, with close last. */}
      <header className="pw-media-head">
        <h2>{group.length > 1 ? `${index + 1} of ${group.length}` : row?.name || 'Image'}</h2>
        <ActionCluster className="pw-media-actions">
          {row && row.kind !== 'video' && url && <MarkupButton attachment={row} done={close} />}
          {url && (
            <IconLink
              icon="download"
              label="Download file"
              href={url}
              download={row?.name || 'image'}
            />
          )}
          <IconButton icon="close" label="Close media viewer" shortcut="Esc" onClick={close} />
        </ActionCluster>
      </header>
      <div
        ref={viewport}
        className="pw-media-viewport"
        onPointerDown={(e) => {
          if (row?.kind === 'video') return;
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
          <p role="alert">Media unavailable: {error}</p>
        ) : url && row?.kind === 'video' ? (
          <video
            key={id}
            src={url}
            controls
            playsInline
            preload="metadata"
            onError={() => setError('Video could not be played')}
          />
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
      <footer className="pw-media-foot">
        {group.length > 1 ? (
          <IconButton
            icon="chevron-left"
            label="Previous"
            type="button"
            disabled={index <= 0}
            onClick={() => setId(group[index - 1].id)}
          />
        ) : (
          <span />
        )}
        <span className="pw-media-caption">{row?.caption || row?.name || caption}</span>
        {row?.kind !== 'video' && (
          <label className="pw-media-zoom">
            <span className="sr-only">Zoom</span>
            <input
              type="range"
              min="1"
              max="5"
              step="0.25"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
        )}
        {group.length > 1 ? (
          <IconButton
            icon="chevron"
            label="Next"
            type="button"
            disabled={index < 0 || index >= group.length - 1}
            onClick={() => setId(group[index + 1].id)}
          />
        ) : (
          <span />
        )}
      </footer>
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
          ['image', 'video'].includes(a.kind) ? (
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
      <summary>
        {screenshotCount(rows.filter((a) => a.kind === 'image').length)}
        {rows.some((a) => a.kind === 'video') ? ' and recording' : ''} from computer use
      </summary>
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

function screenshotCount(count: number) {
  return count === 1 ? '1 screenshot' : `${count} screenshots`;
}
