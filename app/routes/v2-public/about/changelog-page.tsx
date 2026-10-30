import { PublicPage, sourceUrl } from './chrome';
import type { ChangelogRelease } from './changelog';
export function ChangelogPage({ releases }: { releases: ChangelogRelease[] }) {
  return (
    <PublicPage current="changelog">
      <main className="public-container public-changelog">
        <h1>Changelog</h1>
        <p>What’s new and what’s fixed in deploy.local.</p>
        <div>
          {releases.slice(0, 12).map((release) => (
            <article className="public-release" key={release.version}>
              <header>
                <span>{release.date || 'Release'}</span>
                {release.url ? (
                  <a className="dl-meta dl-mono" href={release.url}>
                    {release.version}
                  </a>
                ) : (
                  <span className="dl-meta dl-mono">{release.version}</span>
                )}
              </header>
              <ul>
                {release.items.map((item, i) => (
                  <li key={i}>
                    <span className={`dl-tag ${item.tag === 'New' ? 'public-new' : ''}`}>
                      {item.tag}
                    </span>
                    <span>{item.text}</span>
                    {item.reference && (
                      <a className="dl-meta" href={item.reference.url}>
                        {item.reference.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <a className="dl-link" href={`${sourceUrl}/blob/main/CHANGELOG.md`}>
          All release notes
        </a>
      </main>
    </PublicPage>
  );
}
