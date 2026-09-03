'use client';

import { useCallback, useMemo } from 'react';
import { useWebSocket, type WsEvent } from '../hooks/useWebSocket';
import { getAuth } from '../routes/dashboard/detail/shared';
import { useToast } from './Toaster';

export function DeployNotifications() {
  const auth = getAuth();
  const { toast } = useToast();
  const channels = useMemo(() => (auth ? ['deployments'] : []), [auth]);

  const handleEvent = useCallback(
    (event: WsEvent) => {
      const name = event.deploymentName;

      if (event.type === 'deployment:status') {
        const status = event.data.status as string;

        if (status === 'backing-up' || status === 'restoring') {
          toast(`build-${name}`, {
            type: 'loading',
            title:
              status === 'backing-up'
                ? `Backing up ${name} for migration…`
                : `Restoring ${name} on its new node…`,
            description: 'The current application remains available until the move completes.',
            action: {
              label: 'View progress',
              onClick: () => {
                window.location.href = `/dashboard/${name}/build`;
              },
            },
          });
        } else if (status === 'building') {
          toast(`build-${name}`, {
            type: 'loading',
            title: `Building ${name}...`,
            description: `Triggered by ${(event.data.username as string) || 'unknown'}`,
            action: {
              label: 'View logs',
              onClick: () => {
                window.location.href = `/dashboard/${name}/build`;
              },
            },
          });
        } else if (status === 'starting') {
          toast(`build-${name}`, {
            type: 'loading',
            title: `Starting ${name}...`,
            description: 'Container is starting up',
          });
        } else if (status === 'running') {
          toast(`build-${name}`, {
            type: 'success',
            title: `${name} is running`,
            description: 'Deployment completed successfully',
          });
        } else if (status === 'failed') {
          toast(`build-${name}`, {
            type: 'error',
            title: `${name} failed`,
            description: 'Build or deployment failed',
            action: {
              label: 'View logs',
              onClick: () => {
                window.location.href = `/dashboard/${name}/build`;
              },
            },
          });
        }
      } else if (event.type === 'deployment:deleted') {
        toast(`deleted-${name}`, {
          type: 'info',
          title: `${name} deleted`,
        });
      }
    },
    [toast],
  );

  useWebSocket(channels, handleEvent);

  return null;
}
