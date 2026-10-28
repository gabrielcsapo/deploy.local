import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildDocs } from './render-fixture.mjs';
import { staticRedirects, permanentRedirectResponse } from '../dashboard/v2-redirects.ts';
import { compileDeployYaml } from '../../../server/application-spec.ts';

let fixture;
before(async () => {
  fixture = await buildDocs();
});
after(() => fixture?.close());
const expected = {
  Start: ['Get started', 'Install on a computer', 'Add a computer', 'Your devices'],
  Build: ['Ask and build', 'Review and ship', 'Screenshots and markup'],
  Run: [
    'Live and incidents',
    'Releases and rollback',
    'Projects and apps',
    'Backups and restore',
    'Updates',
  ],
  Agents: ['Agents', 'Approvals', 'Models'],
  Reference: ['CLI', 'deploy.yaml', 'How it works', 'Troubleshooting'],
};
const plain = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const decode = (value) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

test('every nav item has a registered page and every docs route renders', () => {
  assert.deepEqual(fixture.groups, Object.keys(expected));
  for (const [group, titles] of Object.entries(expected))
    assert.deepEqual(
      fixture.docs.filter((doc) => doc.group === group).map((doc) => doc.title),
      titles,
    );
  assert.equal(fixture.paths.length, 19);
  assert.deepEqual(
    new Set(fixture.paths),
    new Set(fixture.docs.map((doc) => fixture.docPath(doc.slug))),
  );
  for (const doc of fixture.docs) {
    const html = fixture.render(fixture.docPath(doc.slug));
    assert.match(html, new RegExp(`<h1>${doc.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h1>`));
    assert.equal([...html.matchAll(/<h1>/g)].length, 1);
    assert.match(html, /aria-label="Docs"/);
    assert.match(html, /aria-label="On this page"/);
    assert.match(html, /Edit this page on GitHub/);
    assert.doesNotMatch(plain(html), /\b(nodes?|deployments?|workspace)\b/i);
  }
});

test('rendered links resolve to docs pages, real headings or existing application routes', () => {
  const rendered = new Map(fixture.paths.map((path) => [path, fixture.render(path)]));
  const routeSource = readFileSync('app/routes.ts', 'utf8');
  const knownOutside = new Set([
    '/',
    '/changelog',
    '/about',
    '/signin',
    '/setup',
    '/recover',
    '/dashboard',
    '/dashboard/agents/scout',
    '/dashboard/agents/new',
    '/dashboard/inbox',
    '/dashboard/computers',
    '/dashboard/computers/add',
    '/dashboard/computers/models',
    '/dashboard/projects',
    '/dashboard/live',
    '/dashboard/settings/account',
    '/dashboard/settings/backups',
    '/dashboard/settings/approvals',
  ]);
  // These are served outside the page router.
  const endpoints = new Set(['/install', '/install.ps1', '/ca.crt']);
  for (const [path, html] of rendered) {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `duplicate id on ${path}`);
    for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
      const href = decode(match[1]);
      const target = new URL(href, 'https://docs.test' + path);
      if (target.origin !== 'https://docs.test') continue;
      if (rendered.has(target.pathname)) {
        if (target.hash)
          assert.ok(
            rendered
              .get(target.pathname)
              .includes(`id="${decodeURIComponent(target.hash.slice(1))}"`),
            `${path} → ${href}`,
          );
      } else {
        assert.ok(
          knownOutside.has(target.pathname) || endpoints.has(target.pathname),
          `unresolved ${path} → ${href}`,
        );
        if (knownOutside.has(target.pathname)) {
          const id =
            target.pathname === '/'
              ? 'home'
              : target.pathname === '/dashboard'
                ? 'dashboard'
                : target.pathname === '/dashboard/agents/scout'
                  ? 'v2-agents-agent'
                  : target.pathname
                      .replace(/^\/dashboard\//, 'v2-')
                      .replace(/^\//, '')
                      .replaceAll('/', '-');
          assert.ok(routeSource.includes(`id: '${id}'`), `application route missing: ${href}`);
        }
      }
    }
  }
});

test('all five old docs URLs return 308 to a rendered canonical page and keep query/hash', async () => {
  const expectedRedirects = {
    '/docs/nodes': '/docs/computers',
    '/docs/managing': '/docs/live',
    '/docs/roadmap': '/docs/ask',
    '/docs/deploying': '/docs/ship',
    '/docs/configuration': '/docs/deploy-yaml',
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(staticRedirects).filter(([path]) => path.startsWith('/docs')),
    ),
    expectedRedirects,
  );
  for (const [oldPath, target] of Object.entries(expectedRedirects)) {
    const response = await permanentRedirectResponse(
      new Request(`https://docs.test${oldPath}?from=bookmark#kept`),
      async () => null,
    );
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('Location'), target + '?from=bookmark#kept');
    assert.ok(fixture.render(target));
  }
});

test('search covers titles and headings without sending a request', () => {
  assert.deepEqual(fixture.searchDocs('   '), []);
  assert.ok(fixture.searchDocs('RELEASES').some((item) => item.href === '/docs/releases'));
  assert.ok(fixture.searchDocs('restore copy').some((item) => item.href === '/docs/backups#copy'));
  assert.ok(fixture.searchDocs('certificate').some((item) => item.href === '/docs/install#trust'));
  assert.ok(fixture.searchDocs('passkey').some((item) => item.href === '/docs/install#passkeys'));
  assert.ok(fixture.searchDocs('mute').some((item) => item.href === '/docs/agents#mute-pause'));
  assert.ok(
    fixture.searchDocs('reversible').some((item) => item.href === '/docs/deploy-yaml#reverse'),
  );
  assert.deepEqual(fixture.searchDocs('no-such-title-123'), []);
});

test('previous and next links follow the exact navigation order', () => {
  fixture.docs.forEach((doc, index) => {
    const html = fixture.render(fixture.docPath(doc.slug));
    const previous = fixture.docs[index - 1];
    const next = fixture.docs[index + 1];
    if (previous) assert.ok(html.includes(`rel="prev" href="${fixture.docPath(previous.slug)}"`));
    else assert.ok(!html.includes('rel="prev"'));
    if (next) assert.ok(html.includes(`rel="next" href="${fixture.docPath(next.slug)}"`));
    else assert.ok(!html.includes('rel="next"'));
  });
});

test('the documented deploy.yaml compiles with the actual manifest parser', () => {
  const html = fixture.render('/docs/deploy-yaml');
  const yaml = decode(html.match(/<code>(apiVersion:[\s\S]*?)<\/code>/)[1]);
  const result = compileDeployYaml(yaml);
  assert.equal(result.spec.routes.public.hostname, 'home-gym.local');
  assert.equal(result.spec.components.web.health.path, '/health');
});

test('recorded CLI examples match the committed evidence verbatim', () => {
  for (const [path, transcript] of [
    ['/docs/cli', 'CliStatus'],
    ['/docs/releases', 'CliReleases'],
    ['/docs/troubleshooting', 'CliErrors'],
  ]) {
    const html = fixture.render(path);
    const evidence = readFileSync(
      `docs/evidence/v2/${transcript === 'CliReleases' ? '11-docs' : '14-cli'}/${transcript}.txt`,
      'utf8',
    );
    const examples = [...html.matchAll(/<code>(\$ deploy[\s\S]*?)<\/code>/g)];
    assert.ok(examples.length);
    for (const [, example] of examples) assert.ok(evidence.includes(decode(example)), path);
  }
});

test('the CLI help block matches the installed command entry point exactly', () => {
  const help = execFileSync(process.execPath, ['bin/deploy.js', '--help'], {
    encoding: 'utf8',
  }).trimEnd();
  const html = fixture.render('/docs/cli');
  const blocks = [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((match) => decode(match[1]));
  assert.ok(blocks.includes(help), 'Refresh the documented command groups and flags from --help');
});
