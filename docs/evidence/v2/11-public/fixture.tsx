import { createRoot } from 'react-dom/client';
import { ChangelogPage } from '../../../../app/routes/v2-public/about/changelog-page';
import About from '../../../../app/routes/v2-public/about/page';
import NotFound from '../../../../app/routes/not-found';
import ErrorPage from '../../../../app/routes/error';
import '../../../../app/design-tokens.css';
import type { ChangelogRelease } from '../../../../app/routes/v2-public/about/changelog';
const releases: ChangelogRelease[] = [
  {
    version: '7f3b2d4',
    date: 'Today',
    items: [
      {
        tag: 'Fixed',
        text: 'Cancelling work on a repository no longer stalls.',
        reference: { label: 'PR #18', url: 'https://github.com/gabrielcsapo/deploy.local/pull/18' },
      },
    ],
  },
  {
    version: '2a91c0e',
    date: 'Today',
    items: [
      {
        tag: 'Fixed',
        text: "An agent's deploy tools now trust your workers' certificates.",
        reference: { label: 'PR #17', url: 'https://github.com/gabrielcsapo/deploy.local/pull/17' },
      },
    ],
  },
  {
    version: '0d96f82',
    date: 'Yesterday',
    items: [
      {
        tag: 'New',
        text: 'Releases started by a pipeline see apps created after deploy.local starts.',
        reference: { label: 'PR #16', url: 'https://github.com/gabrielcsapo/deploy.local/pull/16' },
      },
      {
        tag: 'Fixed',
        text: 'Review diffs include files in new folders.',
        reference: { label: 'PR #15', url: 'https://github.com/gabrielcsapo/deploy.local/pull/15' },
      },
    ],
  },
  {
    version: '3179c28',
    date: 'Oct 24',
    items: [
      {
        tag: 'New',
        text: 'Each release records what verify checked, and when.',
        reference: { label: 'PR #14', url: 'https://github.com/gabrielcsapo/deploy.local/pull/14' },
      },
      {
        tag: 'Fixed',
        text: 'Diffs keep the source they came from after a merge.',
        reference: { label: 'PR #13', url: 'https://github.com/gabrielcsapo/deploy.local/pull/13' },
      },
    ],
  },
];
const screen = new URLSearchParams(location.search).get('screen');
createRoot(document.getElementById('root')!).render(
  screen === 'changelog' ? (
    <ChangelogPage releases={releases} />
  ) : screen === 'not-found' ? (
    <NotFound />
  ) : screen === 'error' ? (
    <ErrorPage />
  ) : (
    <About />
  ),
);
