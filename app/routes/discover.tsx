import { fetchDiscoverableApps } from '../actions/deployments';
import DiscoverClient from './discover.client';

export default async function Discover() {
  const initialApps = await fetchDiscoverableApps();
  return <DiscoverClient initialApps={initialApps} />;
}
