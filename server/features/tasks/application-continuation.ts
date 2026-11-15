// Keep one provider tool call alive using short coordinator requests. Reusing
// the exact operation reservation reads the same attempt; it cannot upload twice.
export async function continueApplication(
  args: any,
  initial: any,
  call: (args: any) => Promise<any>,
  options: { now?: () => number; wait?: () => Promise<void> } = {},
) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
  const deadline = now() + 660000;
  let result = initial;
  while (result.pending === true) {
    if (now() >= deadline)
      throw new Error(
        'Deployment wait interrupted. Retry the identical operationId to inspect the existing attempt; do not start another deployment.',
      );
    await wait();
    try {
      result = await call(args);
    } catch (error: any) {
      if (error.status && error.status < 500 && error.status !== 429) throw error;
    }
  }
  return result;
}
