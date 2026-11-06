// Provider/session configuration belongs to the worker runtime, not task shell commands.
export function shellEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/^(?:npm_config_(?:registry|userconfig|cafile|token)|bun_config_(?:registry|token)|yarn_(?:npm_registry_server|npm_auth_token|npm_always_auth|https_ca_file_path))$/i.test(
          key,
        ) &&
        !/^DEPLOY_(MODEL|WORKER|WORKSPACE|AGENT|SECRET|PACKAGE|NODE|SUPERVISOR)_/.test(key) &&
        !['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'].includes(
          key,
        ),
    ),
  );
}
