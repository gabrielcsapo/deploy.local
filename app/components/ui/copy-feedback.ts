export type CopyFeedback = 'idle' | 'copied' | 'fallback';
export const copyPresentation = (state: CopyFeedback) => ({
  icon: state === 'copied' ? ('check' as const) : ('copy' as const),
  announcement:
    state === 'copied'
      ? 'Copied'
      : state === 'fallback'
        ? 'Clipboard unavailable. Select and copy the text.'
        : '',
});

/** Latest click wins; stale clipboard promises and unmounted controls cannot announce success. */
export function createCopyFeedback(
  update: (state: CopyFeedback) => void,
  write: (text: string) => Promise<void>,
) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    async copy(text: string) {
      const request = ++generation;
      clearTimeout(timer);
      update('idle');
      try {
        await write(text);
        if (generation !== request) return;
        update('copied');
        timer = setTimeout(() => update('idle'), 1500);
      } catch {
        if (generation === request) update('fallback');
      }
    },
    reset() {
      generation++;
      clearTimeout(timer);
      update('idle');
    },
    dispose() {
      generation++;
      clearTimeout(timer);
    },
  };
}
