/** First-line titles reserve room for an ellipsis and retain only complete words. */
export function taskTitle(prompt: string, limit = 72): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0].trim();
  if ([...line].length <= limit) return line;
  const prefix = [...line].slice(0, limit - 1).join('');
  const complete = /\s/.test([...line][limit - 1] || '') ? prefix : prefix.replace(/\s*\S*$/, '');
  const words = complete.trim().split(/\s+/).filter(Boolean);
  while (words.length && /^\d+[\p{P}\p{S}]*$/u.test(words.at(-1)!)) words.pop();
  return (words.join(' ') || '') + '…';
}

/** Preserve editorial titles; replace legacy prompt prefixes with a whole-word title. */
export function publishTitle(stored: string, firstMessage = ''): string {
  const prompt = firstMessage.trim();
  const title = stored.trim();
  const prefix = title.replace(/(?:…|\.{3})$/, '').trimEnd();
  return prompt && (!title || (prompt.startsWith(prefix) && prompt !== title))
    ? taskTitle(prompt)
    : title || taskTitle(prompt);
}
