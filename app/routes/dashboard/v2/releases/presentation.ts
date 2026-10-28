export function missingVariable(detail?: string) {
  return (
    detail?.match(/\b([A-Z][A-Z0-9_]+)\s+(?:is\s+)?(?:not set|missing|undefined|required)/)?.[1] ||
    detail?.match(
      /(?:missing|required)\s+(?:environment\s+)?variable[:\s]+["']?([A-Z][A-Z0-9_]+)/i,
    )?.[1]
  );
}
