#!/usr/bin/env node
// Local changelog generation only. Versions and publication belong to the PR/pipeline.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const library = resolve(import.meta.dirname, '..');
const root = resolve(library, '../..');
const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const code = 'https://deploy.local/dashboard/projects/67d679c5-003f-45d0-b424-53a99dbb0149/code';
let since;
let dryRun = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--dry-run') dryRun = true;
  else if (arg === '--since' && process.argv[i + 1] && !process.argv[i + 1].startsWith('-'))
    since = process.argv[++i];
  else
    throw new Error(
      'Usage: pnpm --filter react-flight-router changelog [--since <ref>] [--dry-run]',
    );
}
if (!since) {
  try {
    since = git('describe', '--tags', '--match', 'react-flight-router@*', '--abbrev=0', 'HEAD');
  } catch {
    // Imported history may arrive without tags. Ignore deploy.local's own releases.
    const releases = git(
      'log',
      '--format=%H%x00%s',
      '--no-merges',
      '--',
      'packages/react-flight-router/package.json',
    );
    since = releases
      .split('\n')
      .find((line) => /^[a-f0-9]+\0release: v\d+\.\d+\.\d+$/.test(line))
      ?.split('\0')[0];
  }
}
if (!since) throw new Error('No router release boundary found; pass --since <ref>.');
const base = git('rev-parse', '--verify', `${since}^{commit}`);
const commits = git(
  'log',
  `${base}..HEAD`,
  '--no-merges',
  '--format=%H%x00%s',
  '--',
  'packages/react-flight-router*',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [hash, subject] = line.split('\0');
    return { hash, subject };
  })
  .filter(({ subject }) => !/^release:/.test(subject));
if (!commits.length) {
  console.log('No router changes since the last release.');
} else {
  const titles = {
    feat: 'Features',
    fix: 'Bug Fixes',
    bug: 'Bug Fixes',
    perf: 'Performance',
    refactor: 'Refactoring',
    docs: 'Documentation',
    test: 'Tests',
    chore: 'Chores',
    build: 'Build',
    ci: 'CI',
  };
  const groups = new Map();
  for (const { hash, subject } of commits) {
    const match = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
    const title = titles[match?.[1]] || 'Other';
    const message = match
      ? `${match[2] ? `**${match[2]}:** ` : ''}${match[3] ? '**Breaking:** ' : ''}${match[4]}`
      : subject;
    const entries = groups.get(title) || [];
    entries.push(
      `- ${message} ([${hash.slice(0, 7)}](${code}?ref=${hash}&path=packages/react-flight-router))`,
    );
    groups.set(title, entries);
  }
  const file = resolve(library, 'CHANGELOG.md');
  const previous = readFileSync(file, 'utf8');
  const { version } = JSON.parse(readFileSync(resolve(library, 'package.json'), 'utf8'));
  // Never overwrite an already published version; maintain Unreleased until the PR bumps it.
  const published =
    version ===
    JSON.parse(git('show', `${base}:packages/react-flight-router/package.json`)).version;
  const heading = published
    ? '## [Unreleased]'
    : `## [${version}] (${new Date().toISOString().slice(0, 10)})`;
  const entry = `${heading}\n\n${[...groups].map(([title, entries]) => `### ${title}\n\n${entries.join('\n')}`).join('\n\n')}\n\n`;
  const withoutUnreleased = previous
    .split(/(?=^## )/m)
    .filter(
      (section) =>
        !section.startsWith('## [Unreleased]') &&
        (published || !section.startsWith(`## [${version}]`)),
    )
    .join('');
  const position = withoutUnreleased.search(/^## /m);
  const updated =
    position < 0
      ? withoutUnreleased.trimEnd() + '\n\n' + entry
      : withoutUnreleased.slice(0, position) + entry + withoutUnreleased.slice(position);
  if (dryRun) process.stdout.write(entry);
  else {
    writeFileSync(file, updated);
    console.log(`Updated ${file}`);
  }
}
