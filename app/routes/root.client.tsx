'use client';

import { useNavigation } from 'react-flight-router/client';

export function GlobalNavigationLoadingBar() {
  const { state } = useNavigation();

  if (state === 'idle') return null;

  return (
    <div className="h-0.5 w-full bg-bg-surface overflow-hidden fixed top-0 left-0 z-[60]">
      <div
        className="animate-progress origin-[0%_50%] w-full h-full"
        style={{ background: 'var(--gradient-brand)' }}
      />
    </div>
  );
}
