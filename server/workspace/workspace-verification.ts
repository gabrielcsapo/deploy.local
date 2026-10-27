type Row = Record<string, any>;

/** Deliberately conservative: never recognize a test mentioned in echo, a script body, or a
 * command mixed with writes. Unknown shell commands remain possible workspace mutations. */
export function verificationCommand(command: string): boolean {
  if (!command || command.length > 10000 || /[`\n\r<>]|\$\(|[;|]|(^|[^&])&([^&]|$)/.test(command))
    return false;
  let verified = false;
  for (const part of command.split('&&')) {
    const words: string[] = part.trim().match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) ?? [];
    while (/^[A-Za-z_][\w]*=/.test(words[0] ?? '')) words.shift();
    if (words[0] === 'env') {
      words.shift();
      while (/^[A-Za-z_][\w]*=/.test(words[0] ?? '')) words.shift();
    }
    if (words[0] === 'cd' && words.length === 2) continue;
    if (words.some((word) => /^(?:--write|--fix|--updateSnapshot|-u)(?:=|$)/.test(word)))
      return false;
    let tool = words.shift()?.split('/').at(-1);
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(tool ?? '')) {
      if (words[0] === 'run' || words[0] === 'exec') words.shift();
      if (
        /^(?:test|typecheck|lint|build|check)(?::[\w-]+)?$/.test(words[0] ?? '') ||
        words[0] === 'format:check'
      ) {
        verified = true;
        continue;
      }
      tool = words.shift();
    } else if (tool === 'npx') tool = words.shift();
    const args = words.join(' ');
    const ok =
      (['node', 'tsx'].includes(tool ?? '') && words.includes('--test')) ||
      /^(?:vitest|jest|mocha|ava|pytest|tsc|oxlint|eslint)$/.test(tool ?? '') ||
      (/^(?:oxfmt|prettier)$/.test(tool ?? '') && words.includes('--check')) ||
      (tool === 'swift' && words[0] === 'test') ||
      (tool === 'cargo' && /^(?:test|check|clippy|build)$/.test(words[0] ?? '')) ||
      (tool === 'go' && /^(?:test|vet|build)$/.test(words[0] ?? '')) ||
      (tool === 'xcodebuild' && /(?:^|\s)(?:test|build|analyze)(?:\s|$)/.test(args));
    if (!ok) return false;
    verified = true;
  }
  return verified;
}

/** Redact before bounding: cutting a quoted assignment first could expose half its value.
 * All assignments and credential arguments are hidden, even innocuous environment values. */
export function scrubCheckText(value: string): string {
  return value
    .replace(/\b([A-Za-z_][\w.-]*=)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|]+)/g, '$1[redacted]')
    .replace(
      /(--?[\w-]*(?:token|password|passwd|secret|key|authorization)[\w-]*\s+)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|]+)/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[^\s'";]+/gi, 'Bearer [redacted]')
    .replace(
      /(["']?(?:password|passwd|secret|token|api[_-]?key|authorization|access[_-]?key|client[_-]?secret|private[_-]?key)["']?\s*:\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,'"}]+)/gi,
      '$1[redacted]',
    )
    .replace(/(Authorization:\s*)(?:"[^"]*"|'[^']*'|[^'"\r\n]+)/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[abposr]-)[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(
      /\b(?:AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      '[redacted]',
    );
}

export function commandText(item: Row): string {
  const command = item.command ?? item.arguments?.command ?? item.arguments?.cmd;
  return typeof command === 'string' ? command : '';
}

export function commandItem(item: Row): boolean {
  return (
    item.type === 'command_execution' ||
    (item.type === 'tool_call' &&
      /^(?:Bash|exec_command|shell|run_command)$/.test(item.name ?? item.tool ?? ''))
  );
}

export function workspaceMutation(item: Row): boolean {
  return (
    item.type === 'file_change' ||
    /^(?:Write|Edit|apply_patch|write_file)$/.test(item.name ?? item.tool ?? '') ||
    (commandItem(item) && !verificationCommand(commandText(item)))
  );
}
