import { writeFile } from 'node:fs/promises';
import { icon } from '../src/icons.mjs';
export async function buildIcons(directory) {
  for (const [name, options] of Object.entries({
    connected: {},
    failing: { failing: true },
    warning: { warning: true },
    offline: { offline: true },
  }))
    await writeFile(`${directory}/tray-${name}.png`, icon(40, options));
  await writeFile(`${directory}/icon.png`, icon(512, { app: true }));
}
