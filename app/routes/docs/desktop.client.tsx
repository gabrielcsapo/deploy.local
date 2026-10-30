'use client';
import { useEffect, useState } from 'react';
import { desktopMacDownload, useMacDownload } from '../../hooks/useDesktopDownload';

/** Download for Mac, or why there is nothing to download, given what the coordinator serves. */
export function DesktopDownloadRow({
  available,
  iPhone = false,
}: {
  available: boolean | undefined;
  iPhone?: boolean;
}) {
  return (
    <div className="docs-v2-download" aria-busy={available === undefined || undefined}>
      {available && (
        <a className="dl-btn primary" href={desktopMacDownload} download>
          Download for Mac
        </a>
      )}
      {available !== undefined && (
        <span className="dl-meta">
          {available
            ? 'Apple silicon. Windows and Linux builds aren’t published yet.'
            : 'The desktop app isn’t published on this coordinator yet.'}
          {available && iPhone && ' On iPhone, open this page on your Mac.'}
        </span>
      )}
    </div>
  );
}

export function DesktopDownload() {
  const available = useMacDownload();
  const [iPhone, setIPhone] = useState(false);
  useEffect(() => setIPhone(/iPhone|iPod/.test(navigator.userAgent)), []);
  return <DesktopDownloadRow available={available} iPhone={iPhone} />;
}
