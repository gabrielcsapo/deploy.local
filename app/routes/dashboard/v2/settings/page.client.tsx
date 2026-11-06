'use client';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import { Group, Icon, Seg, Setting } from '@/components/ui';
import { PackageKeys } from './package-keys.client';
import { Approvals } from './approvals';
import { SettingsFrame } from './frame.client';
export default function Settings() {
  const { pathname } = useLocation();
  return (
    <SettingsFrame>{pathname.endsWith('/approvals') ? <Approvals /> : <General />}</SettingsFrame>
  );
}
function General() {
  const [theme, setTheme] = useState('system');
  useEffect(() => {
    changeTheme(localStorage.getItem('deploy-v2-theme') || 'system');
  }, []);
  function changeTheme(value: string) {
    setTheme(value);
    localStorage.setItem('deploy-v2-theme', value);
    if (value === 'system') document.documentElement.removeAttribute('data-ds-theme');
    else document.documentElement.setAttribute('data-ds-theme', value);
  }
  return (
    <>
      <section className="dl-section">
        <h2 className="dl-section-title">Appearance</h2>
        <Group>
          <div className="dl-inset">
            <Setting label="Theme">
              <Seg
                label="Theme"
                value={theme}
                onChange={changeTheme}
                options={['light', 'dark', 'system'].map((value) => ({
                  value,
                  label: value[0].toUpperCase() + value.slice(1),
                }))}
              />
            </Setting>
          </div>
        </Group>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Account</h2>
        <Group>
          <a className="dl-item" href="/dashboard/settings/account">
            <span className="dl-t">
              <span>Account and SSH keys</span>
              <span>Sign-in and Git access</span>
            </span>
            <Icon name="chevron" />
          </a>
          <a className="dl-item" href="/dashboard/settings/devices">
            <span className="dl-t">Your devices</span>
            <Icon name="chevron" />
          </a>
        </Group>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Agents and data</h2>
        <Group>
          <a className="dl-item" href="/dashboard/settings/approvals">
            <span className="dl-t">Approvals</span>
            <Icon name="chevron" />
          </a>
          <a className="dl-item" href="/dashboard/settings/backups">
            <span className="dl-t">Backups</span>
            <Icon name="chevron" />
          </a>
        </Group>
      </section>
      <PackageKeys />
      <section className="dl-section">
        <h2 className="dl-section-title">Credits</h2>
        <p className="dl-meta">
          Avatars: DiceBear Glyphs by <a href="https://x.com/mattkhouser">Matt Houser</a>, a remix
          of{' '}
          <a href="https://www.figma.com/community/file/1249154526125777853">
            Abstract Avatars for All Creative Profile Use
          </a>
          , licensed under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
        </p>
      </section>
    </>
  );
}
