/** Import a claude.ai design canvas export into design/.
 *
 *   node scripts/design-import.mjs <canvas project folder>
 *
 * The folder holds canvas.json, *.dc.html boards and ds/. Boards become standalone pages in
 * design/boards/ with stable data-layer IDs; canvas.json keeps the layout, sections and notes.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assignLayerIds, convertCanvasBoard } from '../server/design/board-html.ts';

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/design-import.mjs <canvas project folder>');
  process.exit(1);
}
const root = resolve(import.meta.dirname, '../design');
const boardsDir = join(root, 'boards');
mkdirSync(boardsDir, { recursive: true });

const canvas = JSON.parse(readFileSync(join(source, 'canvas.json'), 'utf8'));
const rename = (file) => file.replace(/\.dc\.html$/, '.html');
const boards = {};
for (const [file, board] of Object.entries(canvas.boards)) {
  const exported = readFileSync(join(source, file), 'utf8');
  const { html, size } = convertCanvasBoard(exported);
  writeFileSync(join(boardsDir, rename(file)), assignLayerIds(html));
  boards[rename(file)] = {
    ...board,
    ...(size && !board.w ? { w: size.width, h: size.height } : {}),
  };
}
const order = (canvas.order ?? []).filter((file) => canvas.boards[file]).map(rename);
writeFileSync(
  join(root, 'canvas.json'),
  `${JSON.stringify({ title: canvas.title, boards, order, notes: canvas.notes ?? {} }, null, 2)}\n`,
);

const ds = join(source, 'ds/deploy-local');
for (const file of ['tokens.css', 'tokens.json', 'components/bundle.css']) {
  mkdirSync(join(root, 'ds/deploy-local/components'), { recursive: true });
  copyFileSync(join(ds, file), join(root, 'ds/deploy-local', file));
}
const skipped = readdirSync(source).filter(
  (file) => file.endsWith('.dc.html') && !canvas.boards[file],
);
console.log(
  `Imported ${Object.keys(boards).length} boards into design/boards.${skipped.length ? ` Not on the canvas, skipped: ${skipped.join(', ')}` : ''}`,
);
