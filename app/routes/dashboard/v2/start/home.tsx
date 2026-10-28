'use client';
import { useEffect, useState } from 'react';
import Home from '../../v2-home.client';
import { PasskeyOffer } from './account.client';
import Start from './page.client';
import { api } from '../../../v2-public/client';
export default function Page() {
  const [welcome, setWelcome] = useState(false);
  useEffect(() => {
    void api('/api/v2/auth/account')
      .then((account) => setWelcome(!account.welcomed))
      .catch(() => {});
  }, []);
  return welcome ? (
    <Start />
  ) : (
    <>
      <PasskeyOffer />
      <Home />
    </>
  );
}
