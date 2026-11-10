/**
 * Log limits for every container deploy.local starts. Docker's default json-file driver keeps a
 * container's output forever, and a chatty app fills the disk the whole server depends on.
 * 3 × 20 MB per container. The driver is named because `max-size` is not valid for every
 * driver a daemon might default to; `docker logs` keeps working with json-file. An app's own
 * `docker.runArgs` come later on the command line and can still choose otherwise.
 */
export const CONTAINER_LOG_LIMIT_FLAGS: readonly string[] = [
  '--log-driver',
  'json-file',
  '--log-opt',
  'max-size=20m',
  '--log-opt',
  'max-file=3',
];
