import { useLayoutEffect, type RefObject } from 'react';

/** Keep the same distance from the bottom through each frame of a column/viewport reflow.
 * Scroll events emitted by that reflow must not replace the saved distance first. */
export function trackTranscriptLayout(element: HTMLDivElement) {
  let width = element.clientWidth;
  let viewport = element.clientHeight;
  let bottom = element.scrollHeight - element.scrollTop - viewport;
  const resize = () => {
    if (!element.clientHeight) return;
    if (width !== element.clientWidth || viewport !== element.clientHeight) {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - bottom);
      width = element.clientWidth;
      viewport = element.clientHeight;
    }
    bottom = Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(element);
  element.addEventListener('scroll', resize, true);
  return () => {
    observer.disconnect();
    element.removeEventListener('scroll', resize, true);
  };
}

export function useTranscriptLayoutAnchor(ref: RefObject<HTMLDivElement | null>, active = true) {
  useLayoutEffect(() => {
    if (active && ref.current) return trackTranscriptLayout(ref.current);
  }, [ref, active]);
}
