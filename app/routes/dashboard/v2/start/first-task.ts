export function shouldShowFirstTask(seen: boolean | undefined, firstTask: boolean | undefined) {
  return seen !== true && firstTask === true;
}
