'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  DesignReviewPin,
  DesignReviewPreview,
  DesignReviewScreen,
} from '../../../../../shared/v2/contracts';
import { authenticatedFetch, request } from '../projects/data';

/** A tile needs one image; the viewer and decisions wait for `complete`, both. */
export type Preview = DesignReviewPreview & {
  beforeSrc: string | null;
  afterSrc: string | null;
  complete: boolean;
};
export const previewKey = (board: string, width: number) => `${board}:${width}`;

/** Three loads at a time: every tile's image first, then each screen's other revision. */
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
    type Job = {
      file: string;
      width: number;
      rest?: { preview: DesignReviewPreview; side: 'before' | 'after' };
    };
    const queue: Job[] = boards.map((board) => ({ file: board.file, width: board.widths[0] }));
    async function work() {
      while (queue.length && !controller.signal.aborted) {
        const next = queue.shift()!;
        const key = previewKey(next.file, next.width);
        try {
          if (next.rest) {
            const { preview, side } = next.rest;
            const src = await loadImage(preview[side], controller.signal, urls);
            if (!controller.signal.aborted)
              setPreviews((previous) =>
                previous[key]
                  ? {
                      ...previous,
                      [key]: { ...previous[key], [`${side}Src`]: src, complete: true },
                    }
                  : previous,
              );
            continue;
          }
          const preview = await request<DesignReviewPreview>(
            `${api}/review/preview?item=${encodeURIComponent(item)}&board=${encodeURIComponent(next.file)}&width=${next.width}&scale=${previewScale()}`,
            { signal: controller.signal },
          );
          // The tile shows After, or Before for a removed screen; the other revision follows.
          const shown = preview.after ? 'after' : 'before';
          const other = shown === 'after' ? 'before' : 'after';
          const src = await loadImage(preview[shown], controller.signal, urls);
          if (controller.signal.aborted) return;
          setPreviews((previous) => ({
            ...previous,
            [key]: {
              ...preview,
              beforeSrc: shown === 'before' ? src : null,
              afterSrc: shown === 'after' ? src : null,
              complete: !preview[other],
            },
          }));
          if (preview[other]) queue.push({ ...next, rest: { preview, side: other } });
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
  const complete = (board: DesignReviewScreen) =>
    previews[previewKey(board.file, board.widths[0])]?.complete;
  return {
    previews,
    error,
    retry: () => setRetry((n) => n + 1),
    ready: boards.every(complete),
    loaded: boards.filter(complete).length,
  };
}

/** Inspect an older drawing against its original pixels, even when it is outside this pair. */
export function useReviewPinPreview(api: string, pin?: DesignReviewPin) {
  const [result, setResult] = useState<{ key: string; preview: Preview }>();
  const [error, setError] = useState('');
  const key = pin?.drawing ? `${pin.id}:${pin.revision}:${pin.width}` : '';
  useEffect(() => {
    setError('');
    if (!pin?.drawing) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const drawing = pin.drawing;
    const src = `${api}/render?${new URLSearchParams({ ref: pin.revision, board: pin.board, width: String(drawing.nativeWidth), height: String(drawing.nativeHeight) })}`;
    void (async () => {
      try {
        const response = await authenticatedFetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error('Preview unavailable');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.src = objectUrl;
        await image.decode();
        if (controller.signal.aborted) return;
        setResult({
          key,
          preview: {
            width: drawing.nativeWidth,
            height: drawing.nativeHeight,
            areas: [],
            crop: { x: pin.x, y: pin.y, w: 1, h: 1 },
            before: drawing.side === 'before' ? src : null,
            after: drawing.side === 'after' ? src : null,
            beforeSrc: drawing.side === 'before' ? objectUrl : null,
            afterSrc: drawing.side === 'after' ? objectUrl : null,
            complete: true,
          },
        });
      } catch {
        if (!controller.signal.aborted) setError('The previews could not be loaded. Try again.');
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // Pins retain their original revision and geometry when their text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  return { preview: result?.key === key ? result.preview : undefined, error };
}

const previewScale = () => Math.min(2, Math.max(1, window.devicePixelRatio || 1));

async function loadImage(src: string | null, signal: AbortSignal, urls: string[]) {
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
}

/** One screen at a width with both revisions, for a width the grid did not load. */
async function loadPreview(
  api: string,
  item: string,
  board: string,
  width: number,
  signal: AbortSignal,
  urls: string[],
): Promise<Preview> {
  const preview = await request<DesignReviewPreview>(
    `${api}/review/preview?item=${encodeURIComponent(item)}&board=${encodeURIComponent(board)}&width=${width}&scale=${previewScale()}`,
    { signal },
  );
  const [beforeSrc, afterSrc] = await Promise.all([
    loadImage(preview.before, signal, urls),
    loadImage(preview.after, signal, urls),
  ]);
  return { ...preview, beforeSrc, afterSrc, complete: true };
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
  if (!preview)
    return <div className="dl-review-skeleton dl-skel" aria-label={`Loading ${title}`} />;
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
