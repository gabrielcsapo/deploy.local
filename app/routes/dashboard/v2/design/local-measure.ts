import { measureOverflow, type Overflow } from '../../../../../shared/v2/design-overflow';
import { designApi } from './model';
import { localProjectId } from './local';

/** A board `deploy design dev` saved, to measure at 700 px before its terminal line prints. */
export type SavedBoard = { save: string; file: string; height: number };

/**
 * Loads a board into a hidden frame 700 px wide and measures it from this page, with the rule the
 * check uses. The frame may read its document (same origin) but runs nothing of the board's: its
 * sandbox has no allow-scripts, like the boards on the canvas. Null when the board did not load.
 */
async function measureAt(src: string, height: number): Promise<Overflow | null> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Off screen rather than hidden: a hidden frame lays nothing out.
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:700px;height:${height}px;border:0;pointer-events:none;`;
  try {
    const loaded = new Promise<boolean>((resolve) => {
      frame.addEventListener('load', () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 5000);
    });
    frame.src = src;
    document.body.append(frame);
    if (!(await loaded)) return null;
    const doc = frame.contentDocument;
    if (!doc?.body || doc.contentType !== 'text/html') return null;
    await doc.fonts?.ready;
    return measureOverflow(doc);
  } catch {
    return null;
  } finally {
    frame.remove();
  }
}

/** Measures each saved board as the folder has it and as main has it, and tells the terminal. */
export async function measureSaved(boards: SavedBoard[]) {
  const api = designApi(localProjectId, null);
  // Together: the terminal waits about a second for these before it prints the lines anyway.
  await Promise.all(
    boards.map(async (board) => {
      const file = encodeURIComponent(board.file);
      const [after, before] = await Promise.all([
        measureAt(`${api}/files/0/boards/${file}?v=${board.save}`, board.height),
        measureAt(`${api}/main-files/boards/${file}`, board.height),
      ]);
      if (!after) return;
      await fetch('/api/design-local/measured', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ save: board.save, after, before }),
      }).catch(() => undefined);
    }),
  );
}
