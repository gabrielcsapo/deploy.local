'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Screenshot } from '../../../../../shared/v2/contracts';
import { authenticatedFetch } from '../data/hooks';
import { MarkupView } from '../markup/Markup';
import { mediaRequest } from '../markup/client';
import { safeResourceUrl } from './model';
export function AttachmentImage({ src, alt }: { src: string; alt: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true,
      objectUrl = '';
    const safe = safeResourceUrl(src);
    if (!safe) return;
    void authenticatedFetch(safe)
      .then(async (response) => {
        if (!response.ok) return;
        objectUrl = URL.createObjectURL(await response.blob());
        if (active) setUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => {});
    return () => {
      active = false;
      URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  return <img src={url || undefined} alt={alt} />;
}
export function ScreenshotEvent({ id, screenshot }: { id: string; screenshot?: Screenshot }) {
  const [shot, setShot] = useState(screenshot);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (screenshot) setShot(screenshot);
    else
      void mediaRequest(`/screenshots/${encodeURIComponent(id)}`)
        .then((value) => setShot(value.screenshot))
        .catch(() => {});
  }, [id, screenshot]);
  useEffect(() => {
    if (window.location.hash === `#markup=${encodeURIComponent(id)}`) setOpen(true);
  }, [id]);
  const width = (shot as Screenshot & { width?: number })?.width;
  return shot ? (
    <>
      <figure id={`screenshot-${id}`} className="dl-chat-screenshot">
        <button type="button" onClick={() => setOpen(true)} aria-label="Mark up screenshot">
          <AttachmentImage
            src={shot.image}
            alt={`Screenshot · ${shot.target.device || shot.target.url || shot.target.kind}`}
          />
        </button>
        <figcaption>
          {width
            ? width <= 700
              ? 'iPhone size'
              : `Laptop · ${width} wide`
            : shot.target.device || shot.target.kind}
        </figcaption>
      </figure>
      {open && <MarkupView screenshot={shot} onClose={() => setOpen(false)} />}
    </>
  ) : (
    <p className="dl-meta">Screenshot unavailable</p>
  );
}

export type MediaItem = { src: string; alt: string };

/** One fetch per attachment, shared by its thumbnail and the viewer; the blob says image or video. */
const attachments = new Map<string, Promise<{ url: string; video: boolean }>>();
function loadAttachment(src: string) {
  const safe = safeResourceUrl(src);
  if (!safe) return Promise.reject(new Error('Unsafe attachment'));
  let loading = attachments.get(safe);
  if (!loading) {
    loading = authenticatedFetch(safe).then(async (response) => {
      if (!response.ok) throw new Error(`Attachment ${response.status}`);
      const blob = await response.blob();
      return { url: URL.createObjectURL(blob), video: blob.type.startsWith('video/') };
    });
    loading.catch(() => attachments.delete(safe));
    attachments.set(safe, loading);
  }
  return loading;
}

function useAttachment(src: string) {
  const [value, setValue] = useState<{ url: string; video: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    loadAttachment(src)
      .then((loaded) => active && setValue(loaded))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [src]);
  return value;
}

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

function Thumb({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  const loaded = useAttachment(item.src);
  const [length, setLength] = useState<number | null>(null);
  return (
    <button
      type="button"
      className={`dl-media-thumb${loaded?.video ? ' rec' : ''}`}
      role="listitem"
      aria-label={length ? `${item.alt}, ${clock(length)}` : item.alt}
      onClick={onOpen}
    >
      {loaded?.video ? (
        <video
          src={loaded.url}
          muted
          preload="metadata"
          onLoadedMetadata={(event) => setLength(event.currentTarget.duration || null)}
        />
      ) : loaded ? (
        <img src={loaded.url} alt="" />
      ) : null}
      {loaded?.video && (
        <span className="dl-media-play">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 7v10l8-5z" fill="currentColor" />
          </svg>
        </span>
      )}
      {loaded?.video && length ? <span className="dl-media-time">{clock(length)}</span> : null}
    </button>
  );
}

const arrow = (d: string) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

/** One picture or recording at a time, over the page: previous and next, the count, Escape closes. */
export function MediaViewer({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: MediaItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  const loaded = useAttachment(item.src);
  const close = useRef<HTMLButtonElement>(null);
  const many = items.length > 1;
  const go = (step: number) => onIndex((index + step + items.length) % items.length);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => opener?.focus();
  }, []);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (many && event.key === 'ArrowLeft') go(-1);
      else if (many && event.key === 'ArrowRight') go(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });
  return createPortal(
    <div className="dl-viewer-layer">
      <div
        className="dl-viewer"
        role="dialog"
        aria-modal="true"
        aria-label="Attachments"
        onClick={(event) => event.target === event.currentTarget && onClose()}
      >
        <button
          ref={close}
          type="button"
          className="dl-icon-btn dl-viewer-close"
          aria-label="Close"
          onClick={onClose}
        >
          {arrow('M6 6l12 12M18 6L6 18')}
        </button>
        {many && (
          <button
            type="button"
            className="dl-icon-btn dl-viewer-prev"
            aria-label="Previous"
            onClick={() => go(-1)}
          >
            {arrow('M15 6l-6 6 6 6')}
          </button>
        )}
        <figure className="dl-viewer-fig">
          <span className="dl-viewer-img">
            {loaded?.video ? (
              <video src={loaded.url} controls autoPlay aria-label={item.alt} />
            ) : loaded ? (
              <img src={loaded.url} alt={item.alt} />
            ) : null}
          </span>
        </figure>
        {many && (
          <button
            type="button"
            className="dl-icon-btn dl-viewer-next"
            aria-label="Next"
            onClick={() => go(1)}
          >
            {arrow('M9 6l6 6-6 6')}
          </button>
        )}
        <div className="dl-viewer-bar">
          <span className="dl-viewer-caption">{item.alt}</span>
          {many && (
            <span className="dl-viewer-count" aria-live="polite">
              {index + 1} of {items.length}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Pictures and recordings that come one after another, as a row of thumbnails. */
export function MediaRow({ items }: { items: MediaItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <div
        className="dl-media-row"
        role="list"
        aria-label={`${items.length} ${items.length === 1 ? 'attachment' : 'attachments'}`}
      >
        {items.map((item, index) => (
          <Thumb key={item.src + index} item={item} onOpen={() => setOpen(index)} />
        ))}
      </div>
      {open !== null && (
        <MediaViewer items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

const MEDIA_LINE = /^!?\[([^\]]*)\]\((\/api\/attachments\/[^)\s]+)\)$/;

/**
 * Splits Markdown into text and runs of attachments: a paragraph made only of attachment
 * images or links joins the run before it, so pictures one after another become one row.
 */
export function mediaBlocks(text: string): ({ text: string } | { media: MediaItem[] })[] {
  const out: ({ text: string } | { media: MediaItem[] })[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const media = lines.map((line) => line.match(MEDIA_LINE));
    if (lines.length && media.every(Boolean)) {
      const items = media.map((match) => ({ alt: match![1] || 'Attachment', src: match![2] }));
      const last = out.at(-1);
      if (last && 'media' in last) last.media.push(...items);
      else out.push({ media: items });
    } else {
      const last = out.at(-1);
      if (last && 'text' in last) last.text += `\n\n${block}`;
      else out.push({ text: block });
    }
  }
  return out;
}

/** Markdown whose attachments show as a row that opens the viewer. */
export function MarkdownWithMedia({ text }: { text: string }) {
  return (
    <>
      {mediaBlocks(text).map((block, index) =>
        'media' in block ? (
          <MediaRow key={index} items={block.media} />
        ) : (
          <Markdown key={index} remarkPlugins={[remarkGfm]}>
            {block.text}
          </Markdown>
        ),
      )}
    </>
  );
}
