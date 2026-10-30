'use client';
import { useEffect, useState } from 'react';

/** The coordinator serves the zipped Mac app here (server/desktop-download.ts). */
export const desktopMacDownload = '/desktop?os=darwin&arch=arm64';

/** True when a /desktop/version manifest lists an Apple silicon build. */
export function hasMacDownload(manifest: unknown): boolean {
  const targets = (manifest as { targets?: Record<string, unknown> } | null)?.targets;
  return !!targets && typeof targets === 'object' && !!targets['darwin-arm64'];
}

/**
 * Whether this coordinator publishes the Mac desktop app: `undefined` while
 * checking, then true or false.
 */
export function useMacDownload(): boolean | undefined {
  const [available, setAvailable] = useState<boolean>();
  useEffect(() => {
    let current = true;
    fetch('/desktop/version', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((manifest) => current && setAvailable(hasMacDownload(manifest)))
      .catch(() => current && setAvailable(false));
    return () => {
      current = false;
    };
  }, []);
  return available;
}
