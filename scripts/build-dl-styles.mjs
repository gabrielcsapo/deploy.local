#!/usr/bin/env node
// The web app's dl-* component rules come from the design system: design/ds/deploy-local is the
// source, because design/ is the approved picture of the product and the app must match it.
//
//   node scripts/build-dl-styles.mjs           write the app's copy
//   node scripts/build-dl-styles.mjs --check   fail when the app's copy is out of date
//
// It writes app/components/ui/v2/dl-components.css: every source rule whose selector uses only
// classes the app implements, in source order, with the design system's token names (--paper)
// written as the app's (--ds-canvas) and pixel type sizes as the app's type tokens. Never edit either by hand:
// change the source, then run this. Rules only the app has stay in components.css.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { format } from 'oxfmt';
import {
  GENERATED,
  SOURCE_SHEETS,
  TOKEN_MAP,
  TYPE_MAP,
  appSelector,
  read,
  rules,
} from './dl-styles.mjs';

const rootFlag = process.argv.indexOf('--root');
const root =
  rootFlag > 0 ? resolve(process.argv[rootFlag + 1]) : resolve(import.meta.dirname, '..');
const formatOptions = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../.oxfmtrc.json'), 'utf8'),
);

export async function build(rootDirectory = root) {
  const header = (what) =>
    `/* Generated from design/ds/deploy-local by scripts/build-dl-styles.mjs: ${what}. Do not edit. */\n`;
  let css = header('the dl-* component rules the app implements');
  const keyframes = new Set();
  for (const sheet of SOURCE_SHEETS) {
    for (const rule of rules(read(rootDirectory, sheet))) {
      if (rule.keyframes) {
        if (keyframes.has(rule.keyframes)) continue;
        keyframes.add(rule.keyframes);
        css += `${rule.keyframes} {${rule.body}}\n`;
        continue;
      }
      const selectors = rule.selectors.filter(appSelector);
      if (!selectors.length) continue;
      const body = rule.body
        .replace(/font-size\s*:\s*(\d+)px/g, (all, size) => {
          if (!TYPE_MAP[size]) throw new Error(`${sheet}: no type token for ${all}`);
          return `font-size: var(${TYPE_MAP[size]})`;
        })
        .replace(/var\((--[\w-]+)/g, (all, name) => {
          // The design system's token names, written as the app's: no second set of globals.
          if (name.startsWith('--ds-')) return all;
          if (!TOKEN_MAP[name]) throw new Error(`${sheet}: no app token for ${name}`);
          return `var(${TOKEN_MAP[name]}`;
        });
      const block = `${selectors.join(',\n')} {${body}}`;
      css += rule.context ? `${rule.context} {\n${block}\n}\n` : `${block}\n`;
    }
  }
  const formatted = async (path, code) => {
    const result = await format(path, code, formatOptions);
    if (result.errors.length) throw new Error(`Could not format ${path}`);
    return result.code;
  };
  return {
    [GENERATED]: await formatted(GENERATED, css),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = await build();
  const stale = [];
  for (const [path, contents] of Object.entries(files)) {
    let current = '';
    try {
      current = readFileSync(join(root, path), 'utf8');
    } catch {
      // A missing file is stale.
    }
    if (current === contents) continue;
    if (process.argv.includes('--check')) stale.push(path);
    else writeFileSync(join(root, path), contents);
  }
  if (stale.length) {
    console.error(
      `${stale.join(' and ')} ${stale.length > 1 ? 'are' : 'is'} out of date with design/ds/deploy-local. Run node scripts/build-dl-styles.mjs.`,
    );
    process.exit(1);
  }
  if (!process.argv.includes('--check')) console.log(`Wrote ${Object.keys(files).join(' and ')}.`);
}
