/** `SHA256:q9T…4kE`: enough to tell keys apart; the full fingerprint is in the tooltip. */
export function shortFingerprint(fingerprint: string) {
  return fingerprint.length > 16
    ? `${fingerprint.slice(0, 10)}…${fingerprint.slice(-3)}`
    : fingerprint;
}
/** A name from the key's comment: `gabriel@MacBook-Pro.local` becomes `MacBook Pro`. */
export function keyNameFromComment(publicKey: string) {
  const comment = publicKey.trim().split(/\s+/).slice(2).join(' ');
  if (!comment) return '';
  const computer = comment.includes('@') ? comment.slice(comment.lastIndexOf('@') + 1) : comment;
  return computer
    .replace(/\.local$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .slice(0, 80);
}
