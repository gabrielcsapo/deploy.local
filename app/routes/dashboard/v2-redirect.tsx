import LegacyRedirect from './v2-redirect.client';

// The host should apply permanentRedirectResponse before the router for HTTP 308.
// Client navigation also resolves here, including credentials held in local storage.
export default function RedirectPage() {
  return <LegacyRedirect />;
}
