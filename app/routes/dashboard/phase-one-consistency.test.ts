import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import tokens from '../../design-tokens.json';
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
test('one placeholder and a project-aware prompt across platforms', () => {
  for (const file of [
    '../../../native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2Conversation.swift',
  ]) {
    const value = source(file);
    assert.match(value, /Ask, build, or follow up…/);
    assert.doesNotMatch(
      value,
      /Describe what to build or change…|Ask deploy.local…|Describe the work/,
    );
  }
});
function luminance(hex: string) {
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
test('user bubble normal ink meets AA in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    const values = [
      luminance(tokens.color[theme].text),
      luminance(tokens.color[theme].accentSoft),
    ].sort((a, b) => b - a);
    const contrast = (values[0]! + 0.05) / (values[1]! + 0.05);
    assert.ok(contrast >= 4.5, `${theme}: ${contrast}`);
  }
});
