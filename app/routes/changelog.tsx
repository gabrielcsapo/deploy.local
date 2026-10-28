import rawChangelog from '../../CHANGELOG.md?raw';
import { parseChangelog } from './v2-public/about/changelog';
import { ChangelogPage } from './v2-public/about/changelog-page';
export default function Changelog() {
  return <ChangelogPage releases={parseChangelog(rawChangelog)} />;
}
