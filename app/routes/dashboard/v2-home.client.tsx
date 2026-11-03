'use client';
import type { ReactNode } from 'react';
import { Head, IconButton, Composer } from '@/components/ui';
export default function Home({ banner }: { banner?: ReactNode }) {
  return (
    <>
      <Head
        menu={
          <IconButton
            icon="menu"
            label="Show sidebar"
            className="dl-menu-btn"
            onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
          />
        }
        actions={<IconButton icon="panel" label="Show panel (coming soon)" disabled />}
      />
      {banner}
      <div className="dl-scroll dl-home-scroll">
        <div className="dl-col dl-home-col">
          <div className="dl-greeting">
            <span className="dl-mark dl-home-mark">d</span>
            <h1 className="dl-title">What should we build?</h1>
            <span className="dl-soft">
              Agents work on your computers. You approve merges and releases.
            </span>
          </div>
          <div className="dl-home-composer">
            <Composer />
          </div>
        </div>
      </div>
    </>
  );
}
