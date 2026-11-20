/**
 * Where a review was opened from, so its way back is named after that place ("‹ Waiting on you").
 * The dashboard records each place it shows for this tab; a review opened in a new tab falls back
 * to the page that linked to it, and then to Artifacts.
 */
const key = 'deploy.dashboard.place';

type Places = { current: string; previous: string | null };

function read(): Places | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Places | null;
    return value && typeof value.current === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Called by the dashboard shell whenever its address changes. */
export function rememberPlace(place: string) {
  const places = read();
  if (places?.current === place) return;
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({ current: place, previous: places?.current ?? null } satisfies Places),
    );
  } catch {
    // Without storage the way back falls back to the referring page.
  }
}

export type ReviewOrigin = { label: string; href: string };

const fallback: ReviewOrigin = { label: 'Artifacts', href: '/dashboard/artifacts' };

/** The way back for a place in the dashboard, or null for a place a review does not name. */
export function originOf(place: string): ReviewOrigin | null {
  const url = new URL(place, 'http://deploy.local');
  if (url.pathname === '/dashboard/inbox')
    return { label: 'Waiting on you', href: url.pathname + url.search };
  if (url.pathname === '/dashboard/artifacts' || url.pathname.startsWith('/dashboard/artifacts/'))
    return { label: 'Artifacts', href: url.pathname + url.search };
  return null;
}

/** The same review, whatever board or page its address has moved to since. */
function same(place: string, here: string) {
  const [a, b] = [new URL(place, 'http://deploy.local'), new URL(here, 'http://deploy.local')];
  return a.pathname === b.pathname && a.searchParams.get('review') === b.searchParams.get('review');
}

/**
 * The way back from the review at `here`: the place shown before it in this tab, else the page
 * that linked to it. A review is not its own way back.
 */
export function reviewOrigin(here: string, referrer = ''): ReviewOrigin {
  const places = read();
  const before = places && !same(places.current, here) ? places.current : places?.previous;
  let linked: string | null = null;
  try {
    const url = referrer ? new URL(referrer) : null;
    if (url && url.origin === window.location.origin) linked = url.pathname + url.search;
  } catch {
    // An unreadable referrer names nothing.
  }
  for (const place of [before, linked])
    if (place && !same(place, here)) {
      const origin = originOf(place);
      if (origin) return origin;
    }
  return fallback;
}
