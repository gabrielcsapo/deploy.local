'use client';
import { useEffect, useState } from 'react';
import Home from '../../v2-home.client';
import { PasskeyOffer } from './account.client';
import Start from './page.client';
import { api } from '../../../v2-public/client';
import { useDataSeed, readSeeded } from '../data/seeds';
export default function Page() {
  const seed = useDataSeed();
  const account = seed?.data['/api/v2/auth/account'] as { welcomed?: boolean } | undefined;
  const [welcome, setWelcome] = useState<boolean | null>(account ? !account.welcomed : null);
  useEffect(() => {
    void readSeeded(seed, '/api/v2/auth/account', () => api('/api/v2/auth/account'))
      .then((account) => setWelcome(!account.welcomed))
      .catch(() => setWelcome(false));
  }, [seed]);
  if (welcome === null) return <Home />;
  return welcome ? <Start /> : <Home banner={<PasskeyOffer />} />;
}
