'use client';
import { useEffect, useState } from 'react';
import type { DesignReviewPreview, DesignReviewScreen } from '../../../../../shared/v2/contracts';
import { authenticatedFetch, request } from '../projects/data';

/** The two cached images used by the conversation’s Before / After card. */
export type Preview = DesignReviewPreview & {
  beforeSrc: string | null;
  afterSrc: string | null;
  complete: boolean;
};
export const previewKey = (board: string, width: number) => `${board}:${width}`;

/** Fetch a bounded set of chat-card previews; canvas frames do not use this hook. */
export function useReviewPreviews(api: string, item: string, boards: DesignReviewScreen[]) {
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const signature = JSON.stringify(
    boards.map((board) => [board.file, board.before, board.after, board.widths[0]]),
  );
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
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

// Proposals prepare 1× and 2× images. Fractional browser zoom can use the next sharper copy.
const previewScale = () => (window.devicePixelRatio > 1 ? 2 : 1);

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
