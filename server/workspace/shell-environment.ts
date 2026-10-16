// Provider/session configuration belongs to the worker runtime, not task shell commands.
export function shellEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/^DEPLOY_(MODEL|WORKER|WORKSPACE|AGENT)_/.test(key) &&
        !['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'].includes(
          key,
        ),
    ),
  );
}
