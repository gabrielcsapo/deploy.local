/** Give new elements in design boards a data-layer ID; existing IDs are kept.
 *
 *   node scripts/design-layers.mjs design/boards/Welcome.html [...]
 *
 * With no files, every board in design/boards is updated.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assignLayerIds } from '../server/design/board-html.ts';

const boards = resolve(import.meta.dirname, '../design/boards');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(boards)
      .filter((file) => file.endsWith('.html'))
      .map((file) => join(boards, file));
let changed = 0;
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const next = assignLayerIds(html);
  if (next !== html) {
    writeFileSync(file, next);
    changed++;
  }
}
console.log(`Named new layers in ${changed} of ${files.length} boards.`);
