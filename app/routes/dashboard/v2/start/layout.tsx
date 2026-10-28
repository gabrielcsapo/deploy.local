import { V2Layout } from '../../v2-layout.client';
import { SessionExpired } from './account.client';
export default function Layout() {
  return (
    <>
      <V2Layout />
      <SessionExpired />
    </>
  );
}
