// Isolated API fixture: reuses the Live slice, remapped without editing that slice.
import { readFileSync } from 'node:fs';
import { appNotFoundHtml, appUnavailableHtml } from '../../../../server/edge/app-pages.ts';
globalThis.publicFixturePages = {
  '/__fixtures/app-not-found': appNotFoundHtml('meal-plan.deploy.local', [
    { name: 'meal-planner', title: 'Meals for the week' },
    { name: 'home-gym' },
  ]),
  '/__fixtures/app-unavailable': appUnavailableHtml({
    name: 'home-gym',
    title: 'Workouts',
    state: 'rolling-back',
    computer: 'SER',
    startedAt: '2026-10-27T14:46:00-04:00',
  }),
  '/__fixtures/app-stopped': appUnavailableHtml({
    name: 'recipes',
    state: 'stopped',
    computer: 'SER',
  }),
};
const source = readFileSync(new URL('../2-live/fixture-server.mjs', import.meta.url), 'utf8');
await import(
  `data:text/javascript;base64,${Buffer.from(source.replaceAll('5188', '5199').replace('  const f = fixture();', `  if (globalThis.publicFixturePages[req.url]) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(globalThis.publicFixturePages[req.url]); return; }\n  const f = fixture();`)).toString('base64')}`
);
