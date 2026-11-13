/** Portable mode is unsupported; historical inventory does not gate a Home upgrade. */
export function assertHomeCoordinator(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.DEPLOY_SUITCASE === '1') {
    throw new Error(
      'Portable coordinators are retired. Export this target before upgrading; enroll computers as execution nodes.',
    );
  }
}
