import { convertStoredAttachments } from '../../shared/stored-attachment-urls.ts';
export function readStoredUrls<T>(value: T): T {
  const origins = ['https://deploy.local'];
  if (process.env.DEPLOY_COORDINATOR_URL)
    origins.push(new URL(process.env.DEPLOY_COORDINATOR_URL).origin);
  return convertStoredAttachments(value, origins);
}
