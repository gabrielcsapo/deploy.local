import { on as onEvent } from './events.ts';
import { getDeployment, getNode } from './store.ts';
import {
  DeploymentNotifications,
  normalizeDeploymentNotification,
} from './deployment-notifications.ts';
import { publishSupervisorLine } from './supervisor-publisher.ts';

export const deploymentNotifications = new DeploymentNotifications();
let started = false;

export function startDeploymentNotifications() {
  if (started) return;
  started = true;
  onEvent((event) => {
    const message = normalizeDeploymentNotification(event, {
      deployment: getDeployment,
      node: getNode,
    });
    if (!message) return;
    publishSupervisorLine(JSON.stringify(message) + '\n');
    deploymentNotifications.publish(message);
  });
}
