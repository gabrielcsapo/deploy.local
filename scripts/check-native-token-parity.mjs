import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const spec = JSON.parse(read('app/design-tokens.json'));
const parity = JSON.parse(read('docs/evidence/native-polish/token-parity.json'));
const native = read(parity.nativeSource);
for (const name of parity.matchedNativeTokens) {
  const token = parity.aliases[name] || name;
  const match = native.match(
    new RegExp(
      `static func ${name}\\(_ scheme: ColorScheme\\) -> Color \\{ color\\(scheme == \\.dark \\? 0x([a-f0-9]{6}) : 0x([a-f0-9]{6})\\) \\}`,
    ),
  );
  if (
    !match ||
    match[1] !== spec.color.dark[token].slice(1).toLowerCase() ||
    match[2] !== spec.color.light[token].slice(1).toLowerCase()
  ) {
    throw new Error(`Native token ${name} differs from ${parity.source}: ${token}`);
  }
}
console.log(
  `Native palette parity: ${parity.matchedNativeTokens.length} tokens in both appearances.`,
);
