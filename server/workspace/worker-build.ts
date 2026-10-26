import packageInfo from '../../package.json' with { type: 'json' };

export type WorkerBuild = { version: string; commit?: string };
declare const __WORKER_BUILD_COMMIT__: string | undefined;
// All worker distributions bundle the root package's workspace engine. The Node
// app's independent packaging version is not comparable to the coordinator.
export const workerBuild: WorkerBuild = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : packageInfo.version,
  ...(typeof __WORKER_BUILD_COMMIT__ === 'string' && __WORKER_BUILD_COMMIT__
    ? { commit: __WORKER_BUILD_COMMIT__ }
    : {}),
};
