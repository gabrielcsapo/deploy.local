import { redirect } from 'react-flight-router/server';

// Two hops: /redirect-chain → /redirect-302 → /redirect-destination.
export default function RedirectChain() {
  redirect('/redirect-302');
}
