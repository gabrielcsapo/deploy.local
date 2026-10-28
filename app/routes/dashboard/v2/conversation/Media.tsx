'use client';
import { useEffect, useState } from 'react';
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
