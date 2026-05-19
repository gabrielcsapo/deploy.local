import { getRequest } from 'react-flight-router/server';
import { authenticate, getDeployments } from '../../../server/store.ts';
import { getAllContainerStatuses } from '../../../server/docker.ts';
import DashboardIndexClient from './index.client';

// Pre-container states where Docker has no container yet — duplicate of
// app/actions/deployments.ts and server/api.ts to avoid cross-module imports
// from a server component (each import expands the RSC server bundle).
const PRE_CONTAINER_STATES = new Set(['uploading', 'building', 'starting']);

function parseAuthCookie(cookieHeader: string | null): { username: string; token: string } | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'deploy-sh-auth') {
      try {
        const decoded = decodeURIComponent(rest.join('='));
        const sep = decoded.indexOf(':');
        if (sep === -1) return null;
        return { username: decoded.slice(0, sep), token: decoded.slice(sep + 1) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface InitialDeployment {
  name: string;
  type: string;
  port: number;
  status: string;
  containerId: string;
  createdAt: string;
  updatedAt: string;
}

export default async function DashboardIndex() {
  // Read auth from cookie so the dashboard's deployment list can be inlined
  // into the initial RSC stream. Previously the client component fetched after
  // mount via __action POST, which serialized a synchronous `docker ps`
  // execSync — observable as a multi-second "Loading…" stall.
  //
  // The cookie path is only taken when the browser already has a valid
  // session. The CLI and login flow still use header-based auth.
  const req = getRequest();
  const auth = parseAuthCookie(req?.headers.get('cookie') ?? null);

  let initialDeployments: InitialDeployment[] | null = null;
  if (auth && authenticate(auth.username, auth.token)) {
    try {
      const deps = getDeployments(auth.username);
      const statusMap = await getAllContainerStatuses();
      initialDeployments = deps.map((d) => {
        const dbStatus = d.status || 'stopped';
        const status =
          dbStatus && PRE_CONTAINER_STATES.has(dbStatus)
            ? dbStatus
            : (statusMap.get(d.name.toLowerCase()) ?? 'stopped');
        return {
          name: d.name,
          type: d.type ?? '',
          port: d.port ?? 0,
          status,
          containerId: d.containerId ?? '',
          createdAt: d.createdAt ?? '',
          updatedAt: d.updatedAt ?? '',
        };
      });
    } catch {
      // If anything goes wrong server-side, fall back to client fetch.
      initialDeployments = null;
    }
  }

  return <DashboardIndexClient initialDeployments={initialDeployments} />;
}
