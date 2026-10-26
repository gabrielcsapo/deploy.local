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

/** The text a title describes: an editorial title as written, otherwise the opening request.
 * A stored title cut from that request is legacy truncation, so the full request wins. */
function titleSource(stored: string, firstMessage: string): string {
  const prompt = firstMessage.trim();
  const title = stored.trim();
  const prefix = title.replace(/(?:…|\.{3})$/, '').trimEnd();
  return prompt && (!title || (prompt.startsWith(prefix) && prompt !== title))
    ? prompt
    : title || prompt;
}

/** Preserve editorial titles; replace legacy prompt prefixes with a whole-word title. */
export function publishTitle(stored: string, firstMessage = ''): string {
  const source = titleSource(stored, firstMessage);
  return source === stored.trim() ? source : taskTitle(source);
}

/** Chat openers and politeness that say nothing about the change. */
const filler =
  /^(?:(?:ok(?:ay)?|hi|hey|thanks|so|now|next|also|and|then|please|pls|can you|could you|would you|will you|i'?d like(?: you)? to|i would like(?: you)? to|i want(?: you)? to|i need(?: you)? to|we (?:should|need to|must|want to)|let'?s|you should|go ahead and|help me|try to)\b[,:]?\s+)+/i;

/** The first whole sentence, when the line is too long to use as it stands. */
function firstSentence(line: string, limit: number): string {
  if ([...line].length <= limit) return line;
  const sentence = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? '';
  return [...sentence].length - 1 <= limit && [...sentence].length > 1 ? sentence : line;
}

/**
 * The title of the change a task was asked to make: its own request, stripped of chat filler
 * and sentence punctuation and shortened to whole words. Follow-up messages never title a
 * change — they report on the conversation ("The limit is fixed…"), not on the work.
 */
export function changeTitle(stored: string, firstMessage = '', limit = 72): string {
  const source = titleSource(stored, firstMessage);
  const line = source
    .trim()
    .split(/\r?\n/, 1)[0]
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\*\*(.+?)\*\*$/, '$1');
  const clean = firstSentence(line.replace(filler, ''), limit)
    .replace(/[\s,;:]+$/, '')
    .replace(/\.$/, '')
    .trim();
  if (!clean) return taskTitle(source, limit);
  return taskTitle(clean.charAt(0).toUpperCase() + clean.slice(1), limit);
}
