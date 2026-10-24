/** Where a task was left: the transcript offset (null: follow the latest) and the draft caret. */
export interface ReadingPosition {
  top: number | null;
  start: number;
  end: number;
}

/**
 * Only a reader who scrolled up, away from the latest message, gets that place back. A task left
 * while it was still loading, or while following the conversation, reopens at the latest message
 * (as the Mac app does); otherwise a glance at a loading task saved the top of its first message.
 */
export function readingPosition(
  transcript: { scrollTop: number } | null | undefined,
  following: boolean,
  composer?: { selectionStart: number | null; selectionEnd: number | null } | null,
): ReadingPosition {
  return {
    top: following || !transcript ? null : transcript.scrollTop,
    start: composer?.selectionStart || 0,
    end: composer?.selectionEnd || 0,
  };
}

/**
 * Jump to the latest message at once. A smooth scroll from the top of a long transcript was
 * interrupted by the next render or task switch a few pixels down, and its scroll events then
 * marked the reader as having scrolled away, so the task stayed at its first message.
 */
export function scrollToLatest(transcript: HTMLElement | null | undefined) {
  transcript?.scrollTo({ top: transcript.scrollHeight, behavior: 'instant' });
}
