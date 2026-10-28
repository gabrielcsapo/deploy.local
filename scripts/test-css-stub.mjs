import { registerHooks } from 'node:module';

// Web unit tests import components whose stylesheets only a bundler can load.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
