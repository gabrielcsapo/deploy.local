import { createRequire } from 'module';
import { resolve, dirname } from 'path';

/**
 * Load react-server-dom-webpack/server.node with the react-server condition.
 *
 * The challenge: react-server-dom-webpack requires React loaded with the
 * "react-server" condition (exports React.__SERVER_INTERNALS_...).
 * But in dev mode, the main Node.js process doesn't have this condition.
 *
 * Solution: Manually load the react-server variant and patch its internals
 * onto the main React module before importing react-server-dom-webpack.
 */
export async function loadRSCServerRuntime(): Promise<{
  renderToReadableStream: (model: unknown, webpackMap: unknown, options?: any) => ReadableStream;
  registerClientReference: (proxy: any, id: string, name: string) => any;
  registerServerReference: (fn: Function, id: string, name: string) => void;
  decodeReply: (body: any, manifest: unknown) => Promise<unknown[]>;
  decodeAction: (formData: FormData, manifest: unknown) => Promise<() => Promise<unknown>>;
}> {
  // Use createRequire so we can resolve CJS modules
  const require = createRequire(import.meta.url);

  // Load the normal React first
  const React = require('react');

  // Check if server internals already exist
  if (!React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE) {
    // Load the react-server variant to get server internals
    const reactPath = require.resolve('react');
    const reactDir = dirname(reactPath);

    // React's react-server entry loads: ./cjs/react.react-server.development.js
    // in development, or ./cjs/react.react-server.production.js in production
    const isDev = process.env.NODE_ENV !== 'production';
    const serverCjsFile = isDev
      ? 'cjs/react.react-server.development.js'
      : 'cjs/react.react-server.production.js';

    const serverReactPath = resolve(reactDir, serverCjsFile);

    try {
      const ReactServer = require(serverReactPath);

      // Patch the server internals onto the main React module
      if (ReactServer.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE) {
        React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE =
          ReactServer.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      }
    } catch (e) {
      console.warn(
        '[flight-router] Could not load react-server variant, trying alternate path...',
      );

      // Try the direct react.react-server.js path
      try {
        const altPath = resolve(reactDir, 'react.react-server.js');
        const ReactServerAlt = require(altPath);
        if (ReactServerAlt.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE) {
          React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE =
            ReactServerAlt.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
        }
      } catch {
        throw new Error(
          '[flight-router] Cannot load react-server internals. ' +
          'Ensure react@19+ is installed.',
        );
      }
    }
  }

  // Now we can safely load react-server-dom-webpack/server.node
  const rscServerDom = require('react-server-dom-webpack/server.node');
  return rscServerDom;
}
