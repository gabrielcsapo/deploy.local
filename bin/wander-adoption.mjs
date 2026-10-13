import { sourceBundle } from './ci-release.mjs';
/** One owner/admin account operation; scoped CI authentication cannot adopt storage. */
export async function runWanderAdoptionCli(positionals, values, config, request, authHeaders) {
  if (process.env.DEPLOY_AUTH_JSON || process.env.DEPLOY_AUTH_FILE)
    throw Error('Managed adoption requires owner account authentication');
  if ((values.application || values.app) !== 'wander')
    throw Error('Managed adoption is limited to --application wander');
  if (!config.username || !config.token)
    throw Error('Log in with the Wander owner administrator account');
  const url = new URL(values.url || config.url || 'https://deploy.local');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('Managed adoption requires an HTTPS server origin');
  const root = url.origin + '/api/deployments/wander/managed-adoption';
  const headers = authHeaders(config),
    action = positionals[1];
  if (action === 'status' || action === 'preflight') {
    console.log(
      JSON.stringify(
        await request(root + (action === 'preflight' ? '/preflight' : ''), {
          headers,
          redirect: 'error',
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (!values['confirm-downtime']) throw Error('Explicit --confirm-downtime is required');
  if (action === 'recover' || action === 'cancel') {
    if (!values.operation) throw Error('An exact --operation ID is required');
    console.log(
      JSON.stringify(
        await request(root + '/' + action, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          redirect: 'error',
          body: JSON.stringify({ operationId: values.operation, confirmDowntime: true }),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (action !== 'update')
    throw Error('Use adopt status|preflight|update|recover|cancel --application wander');
  if (!values['idempotency-key'] || !values['source-archive-sha256'])
    throw Error('Provide --idempotency-key and the tested --source-archive-sha256');
  const bundle = sourceBundle(values['source-commit']);
  if (bundle.archiveDigest !== values['source-archive-sha256'])
    throw Error('Exact tested source archive mismatch');
  const baseline = await request(root + '/preflight', { headers, redirect: 'error' });
  const fields = {
    name: 'wander',
    confirmDowntime: '1',
    ...baseline,
    sourceCommit: values['source-commit'],
    sourceDigest: bundle.digest,
    sourceArchiveDigest: bundle.archiveDigest,
    requestKey: values['idempotency-key'],
  };
  delete fields.application;
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  form.set('file', new Blob([bundle.body], { type: 'application/gzip' }), 'source.tar.gz');
  console.log(
    JSON.stringify(
      await request(root + '/upload', { method: 'POST', headers, redirect: 'error', body: form }),
      null,
      2,
    ),
  );
}
