/** Electron is the shipped Node runtime on Linux; tool subprocesses must stay headless too. */
export function nodeRuntimeEnvironment(env = process.env): NodeJS.ProcessEnv {
  return env.ELECTRON_RUN_AS_NODE === '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}
