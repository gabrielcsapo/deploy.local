import { routes } from '../../routes.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildDocs } from './render-fixture.mjs';
import { staticRedirects, permanentRedirectResponse } from '../dashboard/v2-redirects.ts';
import { compileDeployYaml } from '../../../server/application-spec.ts';
import { generateInstallScript, serveWindowsInstallScript } from '../../../server/cli-download.ts';

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
    // The shared public header, with Docs marked as the current page.
    // Docs collapse the header earlier (collapse-tablet), so allow extra classes.
    assert.match(html, /<header class="site-header( collapse-tablet)?">/);
    assert.match(html, /<a href="\/docs" aria-current="page">Docs<\/a>/);
    assert.match(html, /<a href="\/about">About<\/a>/);
    assert.doesNotMatch(plain(html), /\b(nodes?|deployments?|workspace)\b/i);
  }
});

test('rendered links resolve to docs pages, real headings or existing application routes', () => {
  const rendered = new Map(fixture.paths.map((path) => [path, fixture.render(path)]));
  const routeIds = new Set();
  const collectRoutes = (entries) => {
    for (const entry of entries) {
      routeIds.add(entry.id);
      if (entry.children) collectRoutes(entry.children);
    }
  };
  collectRoutes(routes);
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
  const endpoints = new Set(['/install', '/install.ps1', '/ca.crt', '/desktop']);
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
          assert.ok(routeIds.has(id), `application route missing: ${href}`);
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

test('the install page shows copyable CLI install commands the coordinator actually serves', () => {
  const html = fixture.render('/docs/install');
  const cli = html.slice(html.indexOf('id="cli"'), html.indexOf('id="trust"'));
  const shown = [...cli.matchAll(/<code>([^<]*)<\/code>/g)].map((match) => decode(match[1]));
  const { posix, windows } = fixture.cliInstallCommands;
  assert.ok(shown.includes(posix), 'the macOS and Linux install command is on /docs/install');
  assert.ok(shown.includes(windows), 'the Windows install command is on /docs/install');
  assert.equal([...cli.matchAll(/aria-label="Copy [^"]+ command"/g)].length, 2);

  // The POSIX script names its own one-line usage; the docs must match it exactly.
  const script = generateInstallScript('http://deploy.local', 'https://deploy.local', null);
  assert.ok(script.includes(`# Usage: ${posix}`));
  let served = '';
  serveWindowsInstallScript(
    { headers: { host: 'deploy.local' } },
    {
      writeHead() {},
      end(body) {
        served = body;
      },
    },
  );
  assert.match(windows, /^irm (http:\/\/deploy\.local)\/install\.ps1 \| iex$/);
  assert.ok(served.includes('http://deploy.local/cli?os=win32&arch=x64'));
});

test('the install page adds other computers with the desktop app or the CLI', () => {
  const html = fixture.render('/docs/install');
  const text = decode(plain(html));
  assert.match(
    text,
    /It will be the coordinator\. Then add your other computers with the desktop app or the CLI\./,
  );
  for (const id of ['other-computers', 'desktop', 'cli'])
    assert.ok(html.includes(`id="${id}"`), `#${id} anchor`);
  assert.ok(html.includes('href="#other-computers">Add your other computers</a>'));
  assert.ok(!text.includes('Install the CLI'));
  const section = decode(
    plain(html.slice(html.indexOf('id="other-computers"'), html.indexOf('id="trust"'))),
  );
  for (const step of [
    'Open deploy.local Desktop . It finds deploy.local on your network, or you type your coordinator’s address.',
    'Check that the certificate it shows is your coordinator’s, then sign in.',
    'Choose what it helps with. Take tasks is on; Use the screen asks for macOS permissions first.',
    'Choose Add . It appears in Computers. Closing the window keeps it working; Quit stops it.',
    'Open System Settings → Privacy & Security and choose Open Anyway. You do this once.',
    'Then run deploy login and approve the matching code in your browser.',
  ])
    assert.ok(section.includes(step), step);
  assert.match(html, /<ol class="dl-steps numbered"/);
});

test('Download for Mac appears only when the coordinator serves a Mac build', () => {
  const row = (available, iPhone) =>
    decode(fixture.renderElement(fixture.DesktopDownloadRow, { available, iPhone }));
  assert.equal(fixture.desktopMacDownload, '/desktop?os=darwin&arch=arm64');
  assert.ok(row(true).includes(`href="${fixture.desktopMacDownload}"`));
  assert.match(row(true), /Download for Mac/);
  assert.match(row(true), /Apple silicon\. Windows and Linux builds aren’t published yet\./);
  assert.doesNotMatch(row(true), /On iPhone/);
  assert.match(row(true, true), /On iPhone, open this page on your Mac\./);
  assert.doesNotMatch(row(false), /Download for Mac|href=/);
  assert.match(row(false), /The desktop app isn’t published on this coordinator yet\./);
  assert.doesNotMatch(row(undefined), /Download for Mac|published/);
  assert.equal(fixture.hasMacDownload({ targets: { 'darwin-arm64': { file: 'a.zip' } } }), true);
  assert.equal(fixture.hasMacDownload({ targets: {} }), false);
  assert.equal(fixture.hasMacDownload(null), false);
});

test('the desktop steps describe what the desktop app actually shows', () => {
  const views = readFileSync('desktop/src/views.mjs', 'utf8');
  const main = readFileSync('desktop/src/main.mjs', 'utf8');
  assert.match(views, /Find your coordinator on your home network, or enter its address\./);
  assert.match(views, /value="\$\{escape\(state\.origin \|\| 'https:\/\/deploy\.local'\)\}"/);
  assert.match(views, /SHA-256 certificate fingerprint/);
  assert.match(views, /<h1>Sign in<\/h1>/);
  assert.match(views, /role\('takeTasks', 'Take tasks'/);
  assert.match(views, /role\('useScreen', 'Use the screen'/);
  assert.match(main, /roles: \{ takeTasks: true \}/);
  assert.match(main, /if \(worker\.selection\.useScreen\) show\('permissions'\)/);
  assert.match(views, /button\(`Add \$\{state\.name\}`, 'join', true\)/);
  assert.match(views, /The worker keeps running when you close the window\./);
  // A computer that only takes tasks stops working on Quit; one that runs apps keeps them up.
  assert.match(views, /'The worker stops until you open the app again'/);
  assert.match(views, /'Apps keep running\. Tasks wait until you open the app again\.'/);
});

test('other pages send desktop setup to the install page instead of calling downloads unavailable', () => {
  for (const path of ['/docs/devices', '/docs/computers']) {
    const html = fixture.render(path);
    assert.ok(html.includes('href="/docs/install#desktop"'), path);
    assert.doesNotMatch(
      plain(html),
      /downloads are unavailable|installers are not published/i,
      path,
    );
  }
});

test('deploy.yaml explains empty Verify volumes and their limits', () => {
  const text = plain(fixture.render(fixture.docPath('deploy-yaml')));
  assert.match(text, /verify: copy.*default.*verify: empty/);
  assert.match(text, /not allowed with external ownership, a bind source or a lifecycle job/);
  assert.match(text, /proves the build starts and answers, but not that it works with real data/);
  assert.match(text, /Activate, where the previous release is started again/);
});
