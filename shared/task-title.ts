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

/** Words that carry nothing on their own, so a shortened title never ends on one. */
const dangling =
  /^(?:a|an|the|and|or|but|so|that|which|who|whom|whose|with|without|for|to|in|into|on|onto|at|by|of|from|as|if|when|while|than|then|also|its|their|our|your|this|these|those|it|is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|should|would|will|may|might|must|not|every|each|any|some|more|most|other|another|per|via|about|after|before|between|across|over|under|plus)$/i;

/** A title that stops mid-thought: trailing punctuation, bare numbers and words that only led
 * into text the title no longer carries. */
function settle(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const last = words.at(-1)!;
    if (/^\d+[\p{P}\p{S}]*$/u.test(last) || dangling.test(last.replace(/[\p{P}\p{S}]+$/u, ''))) {
      words.pop();
      continue;
    }
    break;
  }
  return words
    .join(' ')
    .replace(/[\s,;:]+$/, '')
    .replace(/\.$/, '');
}

/** Punctuation that ends a clause, and the words that start a trailing one. Cutting here leaves
 * a title that still reads as a sentence about the change, where a word cut does not. */
const clauseStart =
  /\s+(?:and|or|but|so|then|plus|also|for|with|without|in|into|on|onto|of|to|from|about|under|over|within|across|by|using|via|when|while|after|before|against|though|although|because|that|which|who|where)\s+\S/gi;

function clauseBoundaries(line: string): number[] {
  return [
    ...[...line.matchAll(/[,;:]|\s+[—–]\s+|\s+-\s+|\s+\(/g)].map((match) => match.index),
    ...[...line.matchAll(clauseStart)].map((match) => match.index),
  ].sort((a, b) => a - b);
}

/**
 * Shorten a title that names a change. A trailing "…" names nothing, so this drops what a
 * reader does not need instead: an "in <subject>" suffix that repeats the project the change
 * already belongs to, then the longest trailing clause it can spare (", and the rest", "; the
 * rest", " so that the rest"), and only then whole words. The result never ends in an ellipsis.
 */
export function shortenTitle(line: string, limit = 72, subject = ''): string {
  let text = line.trim().split(/\r?\n/, 1)[0].trim();
  if ([...text].length <= limit) return text;
  if (subject.trim()) {
    const escaped = subject.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text =
      settle(
        text.replace(
          new RegExp(`[,;]?\\s+(?:in|for|of|on|within|across|to)\\s+${escaped}\\.?$`, 'i'),
          '',
        ),
      ) || text;
    if ([...text].length <= limit) return text;
  }
  // The longest clause that still fits keeps the most of what the request said. Two words is
  // not a title, so a boundary that leaves only those is no better than a word cut.
  for (const point of clauseBoundaries(text).reverse()) {
    const candidate = settle(text.slice(0, point));
    if (candidate.split(/\s+/).length >= 3 && [...candidate].length <= limit) return candidate;
  }
  const characters = [...text];
  const prefix = characters.slice(0, limit).join('');
  const whole = /\s/.test(characters[limit] || '') ? prefix : prefix.replace(/\s*\S*$/, '');
  return settle(whole) || prefix;
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
 * and sentence punctuation and shortened at a clause boundary. Follow-up messages never title a
 * change — they report on the conversation ("The limit is fixed…"), not on the work. `subject`
 * is the project the change belongs to, whose name a title does not need to repeat.
 */
export function changeTitle(stored: string, firstMessage = '', limit = 72, subject = ''): string {
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
  if (!clean) return shortenTitle(source, limit, subject);
  return shortenTitle(clean.charAt(0).toUpperCase() + clean.slice(1), limit, subject);
}
