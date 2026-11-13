'use client';
import { useEffect, useState } from 'react';
import { useDataSeed, freshSeed } from '../routes/dashboard/v2/data/seeds';

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
  const seed = useDataSeed();
  const [available, setAvailable] = useState<boolean | undefined>(() =>
    seed && (Object.hasOwn(seed.data, '/desktop/version') || seed.errors?.['/desktop/version'])
      ? hasMacDownload(seed.data['/desktop/version'])
      : undefined,
  );
  useEffect(() => {
    if (freshSeed(seed, '/desktop/version')) return;
    let current = true;
    fetch('/desktop/version', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((manifest) => current && setAvailable(hasMacDownload(manifest)))
      .catch(() => current && setAvailable(false));
    return () => {
      current = false;
    };
  }, [seed]);
  return available;
}
