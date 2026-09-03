import { resolve } from 'node:path';

/** Single source of truth for every deploy.local-owned state path. */
export function deployDataDirectory(): string {
  return resolve(process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data'));
}

export function deployDataPath(...segments: string[]): string {
  return resolve(deployDataDirectory(), ...segments);
}
