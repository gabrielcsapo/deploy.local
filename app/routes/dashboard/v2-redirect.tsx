import LegacyRedirect from './v2-redirect.client';

// Only old application pages (`/dashboard/<app>/...`) still come here: finding their project may
// need credentials held in local storage, which only the browser has. The host answers them with
// a 308 when it can resolve them itself (permanentRedirectResponse). Every other old page is a
// declared `redirect` in app/routes.ts.
export default function RedirectPage() {
  return <LegacyRedirect />;
}
