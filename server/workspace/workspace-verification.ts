type Row = Record<string, any>;

/** What a recognized verification command can be trusted to say about its own result. */
export type VerificationRun = {
  /** The command's output went through a pipe, so the shell's status is the last stage's. */
  piped: boolean;
  /** The exit code describes the verification itself: nothing was piped, or pipefail was set
   * before the pipe, which makes the pipeline fail when any stage does. */
  trustedExitCode: boolean;
  /**
   * Every tool in the command prints nothing when it passes (`tsc`, `oxlint`, `oxfmt --check`),
   * so a tail carrying no diagnostic is their pass. Test runners always print a summary and are
   * never silent: without their summary the run stays unknown.
   */
  silentOnSuccess: boolean;
};

/**
 * A bounded tail of a command's output: `| tail -60`, `| tail -n 60`, `| head -20`. Nothing
 * else may follow a pipe, so no stage can filter, rewrite or store what the command reported.
 */
const outputTail = /\s*\|\s*(?:tail|head)(?:\s+-(?:n\s*)?\d+)?\s*$/;

/** Package scripts and tools that print only diagnostics, so passing output is empty. */
const silentScript = /^(?:typecheck|lint|format:check)(?::[\w-]+)?$/;
const silentTool = /^(?:tsc|vue-tsc|oxlint|eslint|oxfmt|prettier)$/;

/** Deliberately conservative: never recognize a test mentioned in echo, a script body, or a
 * command mixed with writes. Unknown shell commands remain possible workspace mutations. */
export function verificationRun(command: string): VerificationRun | null {
  if (!command || command.length > 10000) return null;
  // `2>&1` only merges stderr into what the agent reads; it writes nothing, so it is dropped
  // before redirections and background operators are rejected.
  const text = command.replace(/(^|\s)2>&1(?=\s|$)/g, '$1');
  if (/[`\n\r<>]|\$\(|[;]|\|\||(^|[^&])&([^&]|$)/.test(text)) return null;
  let verified = false;
  let piped = false;
  let pipefail = false;
  let trustedExitCode = true;
  let silentOnSuccess = true;
  for (const segment of text.split('&&')) {
    let part = segment.trim();
    if (part.includes('|')) {
      const head = part.replace(outputTail, '');
      // One bounded tail, at the end, and nothing else: any other pipe could hide a failure.
      if (head === part || head.includes('|')) return null;
      part = head.trim();
      piped = true;
      // Without pipefail the pipeline reports `tail`'s success, whatever the command did.
      if (!pipefail) trustedExitCode = false;
    }
    const words: string[] = part.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) ?? [];
    while (/^[A-Za-z_][\w]*=/.test(words[0] ?? '')) words.shift();
    if (words[0] === 'env') {
      words.shift();
      while (/^[A-Za-z_][\w]*=/.test(words[0] ?? '')) words.shift();
    }
    if (words[0] === 'cd' && words.length === 2) continue;
    // `set -o pipefail` makes every later pipeline report the command's own failure.
    if (words[0] === 'set') {
      let option = false;
      for (const word of words.slice(1)) {
        if (/^-[a-z]+$/.test(word)) option = word.includes('o');
        else if (word === 'pipefail' && option) pipefail = true;
        else return null;
      }
      continue;
    }
    // A quoted separator between checks ("=== LINT ===") labels output and writes nothing.
    if (words[0] === 'echo') continue;
    if (words.some((word) => /^(?:--write|--fix|--updateSnapshot|-u)(?:=|$)/.test(word)))
      return null;
    let tool = words.shift()?.split('/').at(-1);
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(tool ?? '')) {
      if (words[0] === 'run' || words[0] === 'exec') words.shift();
      const script = words[0] ?? '';
      if (/^(?:test|typecheck|lint|build|check)(?::[\w-]+)?$/.test(script)) {
        verified = true;
        if (!silentScript.test(script)) silentOnSuccess = false;
        continue;
      }
      tool = words.shift();
    } else if (tool === 'npx') tool = words.shift();
    const args = words.join(' ');
    const ok =
      (['node', 'tsx'].includes(tool ?? '') && words.includes('--test')) ||
      /^(?:vitest|jest|mocha|ava|pytest|tsc|vue-tsc|oxlint|eslint)$/.test(tool ?? '') ||
      (/^(?:oxfmt|prettier)$/.test(tool ?? '') && words.includes('--check')) ||
      (tool === 'swift' && words[0] === 'test') ||
      (tool === 'cargo' && /^(?:test|check|clippy|build)$/.test(words[0] ?? '')) ||
      (tool === 'go' && /^(?:test|vet|build)$/.test(words[0] ?? '')) ||
      (tool === 'xcodebuild' && /(?:^|\s)(?:test|build|analyze)(?:\s|$)/.test(args));
    if (!ok) return null;
    if (!silentTool.test(tool ?? '')) silentOnSuccess = false;
    verified = true;
  }
  return verified ? { piped, trustedExitCode, silentOnSuccess } : null;
}

export function verificationCommand(command: string): boolean {
  return verificationRun(command) !== null;
}

/** The quoted or bare value an assignment, flag or header carries, up to the next separator. */
const assignedValue = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|]+)`;
/** A whole word that says the value beside it is a credential. Matching whole words, rather than
 * substrings, is what keeps `--author` and `--keyword` out of it. */
const secretWord = String.raw`(?:tokens?|passwords?|passwd|secrets?|keys?|auth|authorization|credentials?|api[-_.]?keys?|access[-_.]?tokens?)`;
/** Names built around such a word, wherever they appear: `--api-key`, `?access_token=`, `PASS`. */
const secretName = String.raw`(?:[\w.]*[-_.])?${secretWord}(?:[-_.][\w.-]*)?`;

/**
 * Redact before bounding: cutting a quoted assignment first could expose half its value.
 *
 * Environment assignments are hidden whatever they are named, because a command's environment is
 * where credentials are passed, and so is any flag or key whose own name says it carries one. An
 * ordinary `--flag=value` argument is kept: `--test-name-pattern="never claims"` is what a check
 * checked, and redacting it left reviewers reading `[redacted]` instead of the test that ran.
 */
export function scrubCheckText(value: string): string {
  return (
    value
      // `FOO=bar cmd`: an assignment is a word of its own, so a flag's `=` can never match here.
      .replace(
        new RegExp(String.raw`(?<![^\s;&|])([A-Za-z_]\w*=)${assignedValue}`, 'g'),
        '$1[redacted]',
      )
      .replace(
        new RegExp(String.raw`(?<![\w.-])(--?${secretName}(?:=|\s+))${assignedValue}`, 'gi'),
        '$1[redacted]',
      )
      .replace(
        new RegExp(String.raw`(?<![\w.-])(${secretName}=)${assignedValue}`, 'gi'),
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
      )
  );
}

export function commandText(item: Row): string {
  const command = item.command ?? item.arguments?.command ?? item.arguments?.cmd;
  return typeof command === 'string' ? command : '';
}

/** How much of a command's output is read for a result: its end, where every tool reports. */
const outputTailChars = 20_000;

function itemText(value: unknown, depth: number): string {
  if (typeof value === 'string') return value;
  if (value == null || depth > 3) return '';
  if (Array.isArray(value)) return value.map((entry) => itemText(entry, depth + 1)).join('\n');
  if (typeof value === 'object') {
    const row = value as Row;
    return itemText(row.text ?? row.content ?? row.output ?? row.stdout, depth + 1);
  }
  return '';
}

/** The output a recorded command produced, from whichever field its agent reported: Codex sends
 * aggregated text, and a Claude tool result sends a string or content blocks. */
export function commandOutput(item: Row): string {
  return itemText(item.aggregated_output ?? item.output ?? item.result ?? item.error, 0).slice(
    -outputTailChars,
  );
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
