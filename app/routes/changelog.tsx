// CHANGELOG.md is generated from conventional commits via release-it.
// Vite resolves `?raw` to the file's text content at build time, so we can
// render the live CHANGELOG without runtime fs access or a markdown lib.
import rawChangelog from '../../CHANGELOG.md?raw';

interface Section {
  title: string;
  items: string[];
}

interface Release {
  version: string;
  versionLinkUrl: string | null;
  date: string;
  sections: Section[];
}

function parseChangelog(raw: string): Release[] {
  const releases: Release[] = [];
  const lines = raw.split('\n');
  let current: Release | null = null;
  let currentSection: Section | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    // Top-level title — skip.
    if (line.startsWith('# ')) continue;

    // Release header: "## [X.Y.Z](url) (date)" or "## X.Y.Z (date)"
    const releaseMatch = line.match(/^##\s+\[?([^\]\s]+)\]?(?:\(([^)]+)\))?\s*(?:\(([^)]+)\))?$/);
    if (releaseMatch && !line.startsWith('### ')) {
      current = {
        version: releaseMatch[1],
        versionLinkUrl: releaseMatch[2] || null,
        date: releaseMatch[3] || '',
        sections: [],
      };
      releases.push(current);
      currentSection = null;
      continue;
    }

    // Section header: "### Features" / "### Bug Fixes" / "### Chores"
    const sectionMatch = line.match(/^###\s+(.+)$/);
    if (sectionMatch && current) {
      currentSection = { title: sectionMatch[1], items: [] };
      current.sections.push(currentSection);
      continue;
    }

    // Bullet item
    if (line.startsWith('- ') && currentSection) {
      currentSection.items.push(line.slice(2));
    }
  }

  return releases;
}

// Render text with inline markdown links and "[hash](url)" commit suffixes
// stripped to compact glyphs.
function renderItem(text: string): React.ReactNode {
  // Commit reference: "([hash](url))" or " ([hash](url))"
  // Strip and append a compact link at end.
  const commitMatch = text.match(/\s*\(\[([0-9a-f]{6,40})\]\(([^)]+)\)\)\s*$/i);
  let body = text;
  let commitNode: React.ReactNode = null;
  if (commitMatch) {
    body = text.slice(0, commitMatch.index).trim();
    commitNode = (
      <>
        {' '}
        <a
          href={commitMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-text-tertiary hover:text-accent font-mono text-xs"
        >
          {commitMatch[1].slice(0, 7)}
        </a>
      </>
    );
  }

  // Inline links: [text](url)
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = linkRe.exec(body)) !== null) {
    if (m.index > lastIndex) parts.push(body.slice(lastIndex, m.index));
    parts.push(
      <a
        key={`a-${key++}`}
        href={m[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent hover:text-accent-hover"
      >
        {m[1]}
      </a>,
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));

  return (
    <>
      {parts.length > 0 ? parts : body}
      {commitNode}
    </>
  );
}

export default function Component() {
  const releases = parseChangelog(rawChangelog);
  const visible = releases.slice(0, 12); // most recent dozen

  return (
    <main className="max-w-[760px] mx-auto px-6 py-16 sm:py-24">
      <p className="eyebrow mb-4">Changelog</p>
      <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight leading-snug mb-3">
        What changed
      </h1>
      <p className="text-text-secondary leading-relaxed mb-12 max-w-[60ch]">
        Release notes for deploy.local. Generated from conventional commits — see{' '}
        <a
          href="https://github.com/gabrielcsapo/deploy.local/blob/main/CHANGELOG.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:text-accent-hover"
        >
          the full CHANGELOG
        </a>{' '}
        for older versions.
      </p>

      {/* Curated "what's new" callouts above the auto-generated release log.
          Conventional-commit titles are great for the audit trail but
          terrible at communicating product highlights to someone evaluating
          the platform. Hand-authored cards bridge that gap. Update when
          shipping a notable feature. */}
      <section className="mb-16">
        <p className="eyebrow mb-4">Recent highlights</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <HighlightCard
            badge="New"
            title="Fleet-wide live logs"
            body="Tail every container in one interleaved stream. Per-app color chips, level filters, search."
            href="/dashboard/logs"
          />
          <HighlightCard
            badge="New"
            title="Dashboard IA refresh"
            body="Split into Overview / Apps / Activity / Logs / Shared apps. Sticky sidebar, full-width main."
            href="/dashboard"
          />
          <HighlightCard
            badge="Polish"
            title="Brand refresh"
            body="Violet → pink gradient identity, new diamond mark, decolored stat numerals."
          />
          <HighlightCard
            badge="Polish"
            title="Real CLI in hero"
            body="The home page's animated terminal now mirrors deploy CLI output verbatim."
            href="/"
          />
        </div>
      </section>

      <p className="eyebrow mb-4">Releases</p>
      <div className="space-y-12">
        {visible.map((release) => (
          <Release key={release.version} release={release} />
        ))}
      </div>
    </main>
  );
}

function HighlightCard({
  badge,
  title,
  body,
  href,
}: {
  badge: string;
  title: string;
  body: string;
  href?: string;
}) {
  const isNew = badge.toLowerCase() === 'new';
  const badgeClass = isNew ? 'badge-accent' : 'badge-success';
  const inner = (
    <div className="group relative card p-4 h-full transition-colors hover:border-border-hover">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`badge ${badgeClass} text-[10px]`}>{badge}</span>
      </div>
      <h3 className="text-sm font-semibold mb-1">{title}</h3>
      <p className="text-xs text-text-secondary leading-relaxed">{body}</p>
      {href && (
        <span className="absolute right-3 top-3 text-text-tertiary group-hover:text-accent transition-colors text-xs">
          →
        </span>
      )}
    </div>
  );
  if (!href) return inner;
  return (
    <a href={href} className="block">
      {inner}
    </a>
  );
}

function Release({ release }: { release: Release }) {
  return (
    <article className="grid grid-cols-1 sm:grid-cols-[120px_1fr] gap-x-6 gap-y-3">
      <header className="sm:sticky sm:top-8 self-start">
        {release.versionLinkUrl ? (
          <a
            href={release.versionLinkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-sm font-semibold text-text hover:text-accent"
          >
            v{release.version}
          </a>
        ) : (
          <span className="font-mono text-sm font-semibold text-text">v{release.version}</span>
        )}
        {release.date && (
          <p className="font-mono text-xs text-text-tertiary mt-0.5 tabular-nums">{release.date}</p>
        )}
      </header>
      <div className="space-y-5 min-w-0">
        {release.sections.map((section) => (
          <section key={section.title}>
            <p className="eyebrow mb-2">{section.title}</p>
            <ul className="space-y-1.5">
              {section.items.map((item, i) => (
                <li
                  key={i}
                  className="text-sm text-text-secondary leading-relaxed flex gap-2 min-w-0"
                >
                  <span className="text-text-tertiary shrink-0">·</span>
                  <span className="min-w-0 break-words">{renderItem(item)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}
