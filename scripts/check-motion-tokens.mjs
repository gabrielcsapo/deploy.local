import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const paths = ['app/motion.css', 'app/native-workspace.css', 'app/design-system.css'];
for (const dir of ['app/routes/dashboard', 'app/components/ui']) {
  for (const name of readdirSync(new URL(dir, root)))
    if (name.endsWith('.css')) paths.push(`${dir}/${name}`);
}
const failures = [];
for (const path of paths) {
  const source = readFileSync(new URL(path, root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of source.matchAll(
    /(?:transition(?:-duration|-delay)?|animation(?:-duration|-delay)?)\s*:[^;{}]+/g,
  )) {
    if (/\b\d*\.?\d+(?:ms|s)\b/.test(match[0])) failures.push(`${path}: ${match[0]}`);
  }
}
const native = fileURLToPath(
  new URL('../native/Apple/Packages/DeployKit/Sources/DeployUI', import.meta.url),
);
for (const name of [
  'TaskTreeViews.swift',
  'TaskRightSplit.swift',
  'WorkspaceToolbar.swift',
  'WorkspaceView.swift',
  'WorkspaceSkeleton.swift',
  'TurnMinimap.swift',
  'NewConversationView.swift',
]) {
  const source = readFileSync(resolve(native, name), 'utf8');
  if (/\.animation\(\.(?:ease|linear|spring)|withAnimation\(\.(?:ease|linear|spring)/.test(source))
    failures.push(`${name}: use WorkspaceStyle.Motion`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('Workspace motion: shared duration tokens and native animations.');
