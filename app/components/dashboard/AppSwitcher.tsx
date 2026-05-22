'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'react-flight-router/client';
import { fetchDeployments } from '../../actions/deployments';
import { getAuth } from '../../routes/dashboard/detail/shared';
import { ChevronDownIcon } from './icons';

interface DeploymentLite {
  name: string;
  status: string;
}

export function AppSwitcher({ current }: { current: string }) {
  const { navigate } = useRouter();
  const [deployments, setDeployments] = useState<DeploymentLite[]>([]);

  useEffect(() => {
    const auth = getAuth();
    if (!auth) return;
    fetchDeployments(auth.username, auth.token)
      .then((deps: DeploymentLite[]) => setDeployments(deps))
      .catch(() => {
        /* ignore */
      });
  }, []);

  if (deployments.length === 0) return null;

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">
        Viewing
      </p>
      <label className="relative block">
        <span className="sr-only">Switch deployment</span>
        <select
          value={current}
          onChange={(e) => {
            const next = e.target.value;
            if (next && next !== current) {
              navigate(`/dashboard/${next}`);
            }
          }}
          className="w-full appearance-none rounded-lg border border-border bg-bg-surface px-3 py-2 pr-8 text-sm text-text"
        >
          {deployments.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-text-tertiary" />
      </label>
    </div>
  );
}
