// The capture fixtures in docs/evidence mount real pages with a stand-in for the router. A name the
// app imports that the stand-in lacks is a module error in the browser: the page stays blank and
// every capture times out. That happened to the canvas review fixture when the app began clearing
// the prefetch cache. No test loads the fixtures in a browser, so this reads the imports instead.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
// The stand-ins today's fixtures use. one-search and tasks-group-delete re-export the first.
// The ones under docs/evidence/v2 belong to captures of pages that no longer exist.
const standIns = [
  'docs/evidence/board-parity/fixture-router.tsx',
  'docs/evidence/app-one-page/fixture-router.tsx',
];
// The app's entry mounts the router itself; a fixture mounts the page and never loads the entry.
const entryOnly = new Set(['RouterProvider']);

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Names imported as values from the router's client module, across the app. */
function importedFromRouter() {
  const names = new Map();
  for (const path of sources(join(root, 'app'))) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(
      /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'react-flight-router\/client'/g,
    )) {
      if (match[1]) continue;
      for (const part of match[2].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name && !name.startsWith('type ')) names.set(name, path.slice(root.length + 1));
      }
    }
  }
  return names;
}

test('each fixture router provides every name the app imports from the router', () => {
  const imported = importedFromRouter();
  assert.ok(imported.size > 5, 'found the app’s router imports');
  for (const standIn of standIns) {
    const provided = new Set(
      [...readFileSync(join(root, standIn), 'utf8').matchAll(/^export const (\w+)/gm)].map(
        (match) => match[1],
      ),
    );
    const missing = [...imported]
      .filter(([name]) => !provided.has(name) && !entryOnly.has(name))
      .map(([name, path]) => `${name} (imported in ${path})`);
    assert.deepEqual(missing, [], `Add these to ${standIn}`);
  }
});
