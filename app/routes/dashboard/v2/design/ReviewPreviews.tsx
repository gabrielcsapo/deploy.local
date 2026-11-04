'use client';
import { useEffect, useRef, useState } from 'react';
import type { DesignReviewPreview, DesignReviewScreen } from '../../../../../shared/v2/contracts';
import { authenticatedFetch, request } from '../projects/data';

export type Preview = DesignReviewPreview & { beforeSrc: string | null; afterSrc: string | null };
export const previewKey = (board: string, width: number) => `${board}:${width}`;

/** Three renders at a time. Metadata and authenticated images must both finish before decisions. */
export function useReviewPreviews(
  api: string,
  item: string,
  boards: DesignReviewScreen[],
  selected?: { file: string; width: number },
) {
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const ownedUrls = useRef<string[]>([]);
  const signature = JSON.stringify(
    boards.map((board) => [board.file, board.before, board.after, board.widths[0]]),
  );
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    ownedUrls.current = urls;
    setPreviews({});
    setError('');
    const queue = boards.map((board) => ({ file: board.file, width: board.widths[0] }));
    async function work() {
      while (queue.length && !controller.signal.aborted) {
        const next = queue.shift()!;
        try {
          const preview = await loadPreview(
            api,
            item,
            next.file,
            next.width,
            controller.signal,
            urls,
          );
          if (!controller.signal.aborted)
            setPreviews((previous) => ({
              ...previous,
              [previewKey(next.file, next.width)]: preview,
            }));
        } catch {
          if (!controller.signal.aborted) setError('The previews could not be loaded. Try again.');
        }
      }
    }
    void Promise.all([work(), work(), work()]);
    return () => {
      controller.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
    // The signature names immutable revisions, so pin/seen refreshes do not reload previews.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, item, signature, retry]);
  const selectedKey = selected ? previewKey(selected.file, selected.width) : '';
  const hasSelected = Boolean(previews[selectedKey]);
  useEffect(() => {
    if (
      !selected ||
      hasSelected ||
      boards.find((b) => b.file === selected.file)?.widths[0] === selected.width
    )
      return;
    const controller = new AbortController();
    const urls = ownedUrls.current;
    void loadPreview(api, item, selected.file, selected.width, controller.signal, urls)
      .then((preview) => {
        if (!controller.signal.aborted)
          setPreviews((previous) => ({ ...previous, [selectedKey]: preview }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('The previews could not be loaded. Try again.');
      });
    // Keep selected-width images until the review closes; the main effect releases every URL.
    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, item, selectedKey, retry]);
  return {
    previews,
    error,
    retry: () => setRetry((n) => n + 1),
    ready: boards.every((board) => previews[previewKey(board.file, board.widths[0])]),
  };
}

async function loadPreview(
  api: string,
  item: string,
  board: string,
  width: number,
  signal: AbortSignal,
  urls: string[],
): Promise<Preview> {
  const preview = await request<DesignReviewPreview>(
    `${api}/review/preview?item=${encodeURIComponent(item)}&board=${encodeURIComponent(board)}&width=${width}`,
    { signal },
  );
  const image = async (src: string | null) => {
    if (!src) return null;
    const response = await authenticatedFetch(src, { signal });
    if (!response.ok) throw new Error('Preview unavailable');
    const url = URL.createObjectURL(await response.blob());
    urls.push(url);
    const loaded = new Image();
    loaded.src = url;
    await loaded.decode();
    if (signal.aborted) {
      URL.revokeObjectURL(url);
      throw new Error('Cancelled');
    }
    return url;
  };
  const [beforeSrc, afterSrc] = await Promise.all([image(preview.before), image(preview.after)]);
  return { ...preview, beforeSrc, afterSrc };
}

export function ReviewCrop({
  preview,
  title,
  changed,
}: {
  preview?: Preview;
  title: string;
  changed: boolean;
}) {
  if (!preview) return <div className="dl-review-skeleton" aria-label={`Loading ${title}`} />;
  const crop = preview.crop;
  return (
    <div className="dl-review-image">
      <svg
        role="img"
        aria-label={title}
        style={{ maxWidth: crop.w, maxHeight: Math.min(200, crop.h) }}
        viewBox={`${crop.x} ${crop.y} ${crop.w} ${crop.h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <image
          href={preview.afterSrc ?? preview.beforeSrc ?? ''}
          width={preview.width}
          height={preview.height}
        />
        {changed &&
          preview.areas.map((area) => {
            const rect = area.after ?? area.before;
            return (
              rect && (
                <rect
                  key={area.layer}
                  className="dl-review-crop-outline"
                  x={rect.x}
                  y={rect.y}
                  width={rect.w}
                  height={rect.h}
                />
              )
            );
          })}
      </svg>
    </div>
  );
}
