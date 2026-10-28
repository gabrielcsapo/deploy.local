/** Stable across sessions and independent of the order of the household apps. */
export function appColor(name: string) {
  return (
    [...name.toLowerCase()].reduce((hash, letter) => (hash * 31 + letter.charCodeAt(0)) >>> 0, 0) %
    5
  );
}
