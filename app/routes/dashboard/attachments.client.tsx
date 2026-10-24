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
  const opener = useRef<HTMLButtonElement | null>(null);
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
  // MediaContext follows transcript order; navigation spans every run in the task.
  const group = attachments.filter((a) => ['image', 'video'].includes(a.kind));
  if (row && !group.some((a) => a.id === row.id)) group.push(row);
  return (
    <span
      className="pw-attachment-image"
      onClickCapture={(event) => {
        if (!open && event.target instanceof Element)
          opener.current = event.target.closest('button');
      }}
    >
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
        <ImageViewer
          initialId={id}
          group={group}
          caption={caption}
          opener={opener.current}
          close={() => setOpen(false)}
        />
      )}
    </span>
  );
}
function MediaThumbnail({ attachment }: { attachment: Attachment }) {
  const [url, setURL] = useState('');
  useEffect(() => {
    if (attachment.kind === 'video') return;
    let active = true,
      objectURL = '';
    void mediaFetch(`/api/workspace/attachments/${attachment.id}/thumbnail`)
      .then((response) => response.blob())
      .then((blob) => {
        if (active) {
          objectURL = URL.createObjectURL(blob);
          setURL(objectURL);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [attachment.id, attachment.kind]);
  return attachment.kind === 'video' ? (
    <video
      src={`/api/workspace/attachments/${attachment.id}`}
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => {
        if (event.currentTarget.duration > 0.1) event.currentTarget.currentTime = 0.1;
      }}
      aria-hidden="true"
    />
  ) : url ? (
    <img src={url} alt="" />
  ) : (
    <span>{attachment.caption || attachment.name}</span>
  );
}

function ImageViewer({
  initialId,
  group,
  caption,
  opener,
  close,
}: {
  initialId: string;
  group: Attachment[];
  caption: string;
  opener: HTMLButtonElement | null;
  close: () => void;
}) {
  const [id, setId] = useState(initialId),
    [url, setURL] = useState(''),
    [error, setError] = useState(''),
    [zoom, setZoom] = useState(1);
  const index = group.findIndex((a) => a.id === id),
    row = group[index];
  const isVideo = row?.kind === 'video';
  const name = row?.caption || row?.name || caption;
  const count = `${Math.max(0, index) + 1} of ${Math.max(1, group.length)}`;
  const label = `${isVideo ? 'Video' : 'Image'} ${count}: ${name}`;
  const dialog = useRef<HTMLDialogElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    video = useRef<HTMLVideoElement>(null),
    activeThumbnail = useRef<HTMLButtonElement>(null),
    drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null),
    pointers = useRef(new Map<number, { x: number; y: number }>()),
    pinch = useRef<{ distance: number; zoom: number } | null>(null);
  function select(next: number) {
    if (!group[next] || next === index) return;
    video.current?.pause();
    setZoom(1);
    setURL('');
    setId(group[next].id);
    pointers.current.clear();
    pinch.current = null;
    drag.current = null;
    viewport.current?.scrollTo(0, 0);
  }
  useEffect(() => {
    const returnFocus =
      opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      returnFocus?.focus({ preventScroll: true });
    };
  }, [opener]);
  useEffect(() => {
    activeThumbnail.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [id]);
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
  useEffect(() => {
    const element = viewport.current!;
    const wheel = (event: WheelEvent) => {
      if (isVideo) return;
      event.preventDefault();
      setZoom((value) => Math.min(5, Math.max(1, value * Math.exp(-event.deltaY / 300))));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [isVideo]);
  return (
    <dialog
      ref={dialog}
      className="pw-media-viewer pw-media-gallery"
      aria-label="Media viewer"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        // Nested markup dialogs own their keyboard input.
        if ((event.target as HTMLElement).closest('dialog') !== dialog.current) return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const next = {
          ArrowLeft: index - 1,
          ArrowRight: index + 1,
          Home: 0,
          End: group.length - 1,
        }[event.key];
        if (next !== undefined) {
          event.preventDefault();
          select(next);
        }
      }}
    >
      <header className="pw-media-head">
        <h2 aria-live="polite" aria-atomic="true">
          <span>{count}</span>
          <span className="pw-media-caption">{name}</span>
        </h2>
        <ActionCluster className="pw-media-actions">
          {row && !isVideo && url && <MarkupButton attachment={row} done={close} />}
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
      <div className="pw-media-stage">
        <div
          ref={viewport}
          className="pw-media-viewport"
          onDoubleClick={() => {
            if (!isVideo) setZoom(zoom > 1 ? 1 : 2.5);
          }}
          onPointerDown={(event) => {
            const isPlayer = (event.target as HTMLElement).closest('video');
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const points = [...pointers.current.values()];
            if (points.length === 2) {
              pinch.current = {
                distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
                zoom,
              };
              drag.current = null;
            } else {
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                left: event.currentTarget.scrollLeft,
                top: event.currentTarget.scrollTop,
              };
            }
            if (!isPlayer) event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (isVideo || !pointers.current.has(event.pointerId)) return;
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const points = [...pointers.current.values()];
            if (pinch.current && points.length === 2) {
              setZoom(
                Math.min(
                  5,
                  Math.max(
                    1,
                    (pinch.current.zoom *
                      Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)) /
                      Math.max(1, pinch.current.distance),
                  ),
                ),
              );
            } else if (drag.current && zoom > 1) {
              event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
              event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
            }
          }}
          onPointerUp={(event) => {
            const start = drag.current;
            if (
              start &&
              zoom === 1 &&
              Math.abs(event.clientX - start.x) > 50 &&
              Math.abs(event.clientX - start.x) > Math.abs(event.clientY - start.y)
            )
              select(index + (event.clientX < start.x ? 1 : -1));
            pointers.current.delete(event.pointerId);
            drag.current = null;
            pinch.current = null;
          }}
          onPointerCancel={() => {
            pointers.current.clear();
            drag.current = null;
            pinch.current = null;
          }}
        >
          {error ? (
            <p role="alert">Media unavailable: {error}</p>
          ) : url && isVideo ? (
            <video
              ref={video}
              key={id}
              src={url}
              controls
              playsInline
              preload="metadata"
              aria-label={label}
              onError={() => setError('Video could not be played')}
            />
          ) : url ? (
            <img
              src={url}
              draggable={false}
              onError={() => setError('Image could not be decoded')}
              alt={label}
              style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
            />
          ) : (
            <p role="status">Loading media…</p>
          )}
        </div>
        {group.length > 1 && (
          <>
            <IconButton
              className="pw-media-previous"
              icon="chevron-left"
              label="Previous media"
              shortcut="←"
              size="touch"
              disabled={index <= 0}
              onClick={() => select(index - 1)}
            />
            <IconButton
              className="pw-media-next"
              icon="chevron"
              label="Next media"
              shortcut="→"
              size="touch"
              disabled={index >= group.length - 1}
              onClick={() => select(index + 1)}
            />
          </>
        )}
      </div>
      {group.length > 1 && (
        <nav className="pw-media-filmstrip" aria-label="Media thumbnails">
          {group.map((item, itemIndex) => (
            <button
              key={item.id}
              type="button"
              ref={item.id === id ? activeThumbnail : undefined}
              className="pw-media-film-frame"
              aria-current={item.id === id ? 'true' : undefined}
              aria-label={`${item.kind === 'video' ? 'Video' : 'Image'} ${itemIndex + 1} of ${group.length}: ${item.caption || item.name}`}
              onClick={() => select(itemIndex)}
            >
              <MediaThumbnail attachment={item} />
            </button>
          ))}
        </nav>
      )}
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
            await downloadAttachment(attachment);
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

/** Authenticated download: attachment URLs need the session headers, so save through a blob. */
export async function downloadAttachment(attachment: Pick<Attachment, 'id' | 'name'>) {
  const blob = await (await mediaFetch(`/api/workspace/attachments/${attachment.id}`)).blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function screenshotCount(count: number) {
  return count === 1 ? '1 screenshot' : `${count} screenshots`;
}
