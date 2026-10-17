'use client';
import { Select } from '@/components/ui';

import { useEffect, useState } from 'react';
import { useRouter } from 'react-flight-router/client';
import { fetchDeployments } from '../../actions/deployments';
import { getAuth } from '../../routes/dashboard/detail/shared';

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
        <Select
          value={current}
          onChange={(e) => {
            const next = e.target.value;
            if (next && next !== current) {
              navigate(`/dashboard/${next}`);
            }
          }}
          className="w-full"
        >
          {deployments.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}
