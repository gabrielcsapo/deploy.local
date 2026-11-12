import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const app = fileURLToPath(new URL('../..', import.meta.url));

// Only this exact submit-button expression is exempt. Do not allow-list a whole file:
// a new page/panel loader in the login form must still fail the scan.
const busyLabels = [
  {
    file: 'routes/dashboard/login-form.client.tsx',
    button:
      /<button type="submit" className="btn btn-primary mt-1" disabled=\{loading\}>\s*\{loading \? 'Loading…' : isLogin \? 'Sign in' : 'Register'\}\s*<\/button>/g,
  },
];

function loadingText(source: string, file = '') {
  // Labels are accessible names, not visible prose. Keep the rest of each Skeleton
  // tag in the scan so another prop cannot hide a visible loading message.
  let visible = source.replace(/<Skeleton\b[^>]*\/>/gs, (tag) =>
    tag.replace(/\blabel=(?:"[^"]*"|'[^']*'|\{[^}]*\})/g, ''),
  );
  for (const allowed of busyLabels) {
    if (file === allowed.file) visible = visible.replace(allowed.button, '');
  }
  return [...visible.matchAll(/\bLoading(?:\s+[^"'`<>{}…]*?)?(?:…|\.\.\.)/g)].map(
    (match) => match[0],
  );
}

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : entry.name.endsWith('.tsx') ? [path] : [];
  });
}

test('web loading prose belongs in skeleton labels, except the explicit submit busy label', () => {
  const violations = tsxFiles(app).flatMap((path) => {
    const file = relative(app, path);
    return loadingText(readFileSync(path, 'utf8'), file).map((text) => `${file}: ${text}`);
  });
  assert.deepEqual(violations, []);
  for (const allowed of busyLabels) {
    assert.match(readFileSync(join(app, allowed.file), 'utf8'), allowed.button);
  }
});

test('the scan catches JSX, ternaries and loading strings stored as data', () => {
  for (const source of [
    '<p>Loading…</p>',
    '<div>Loading the design…</div>',
    '<pre>{text === null ? "Loading..." : text}</pre>',
    "const [value] = useState('Loading error lines…');",
    '<p>Loading\n layers…</p>',
    '<Other label="Loading review…" />',
  ]) {
    assert.equal(loadingText(source).length, 1, source);
  }
  assert.deepEqual(loadingText('<Skeleton rows={3} label="Loading layers…" />'), []);
  assert.deepEqual(loadingText('<Skeleton block label={"Loading the design…"} />'), []);
  assert.equal(loadingText('<button>Loading…</button>').length, 1);
  assert.equal(loadingText('<p>Loading…</p>', 'routes/dashboard/login-form.client.tsx').length, 1);
});
