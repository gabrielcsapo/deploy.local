import type {
  DesignRect,
  DesignReviewPreview,
  DesignReviewScreen,
} from '../../../shared/v2/contracts';
import { readFileSync } from 'node:fs';

const sentBoard = readFileSync(
  new URL('../../../design/boards/DesignReviewSent.html', import.meta.url),
  'utf8',
);
function approvedRegion(file: string) {
  const name = file.replace(/\.html$/, '');
  const svg = sentBoard.match(new RegExp(`<svg[^>]*data-screen="${name}"[^>]*>`))?.[0];
  const outline = sentBoard.match(new RegExp(`<rect[^>]*data-changed-area="${name}"[^>]*>`))?.[0];
  const values = svg
    ?.match(/viewBox="([^"]+)"/)?.[1]
    .split(' ')
    .map(Number);
  if (!values) return;
  const [x, y, w, h] = values;
  const rect = outline
    ? Object.fromEntries(
        ['x', 'y', 'width', 'height'].map((key) => [
          key,
          Number(outline.match(new RegExp(` ${key}="([^"]+)"`))?.[1]),
        ]),
      )
    : undefined;
  return {
    crop: { x, y, w, h },
    area: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : undefined,
  };
}

export function fixturePreview(
  board: DesignReviewScreen,
  width: number,
  scale: number,
  before: DesignRect,
  after: DesignRect,
): DesignReviewPreview {
  const image = (side: string) =>
    `/fixture/image?file=${board.file}&side=${side}&width=${width}&scale=${scale}`;
  // These are synthetic revisions of current screens; use the approved contact sheet's
  // geometry, rather than pretending an arbitrary fallback rectangle is a real layer diff.
  const approved = width === board.w ? approvedRegion(board.file) : undefined;
  return {
    width,
    height: board.h,
    before: board.added ? null : image('before'),
    after: board.removed ? null : image('after'),
    areas: [
      {
        layer: approved ? 'fixture-change' : 'composer',
        words: approved ? board.title : 'Input',
        before: board.added ? null : (approved?.area ?? before),
        after: board.removed ? null : (approved?.area ?? after),
      },
    ],
    crop: approved?.crop ?? after,
  };
}
