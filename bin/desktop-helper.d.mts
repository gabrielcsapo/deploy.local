export function runDesktopHelper(
  command: string,
  options?: Record<string, unknown>,
): Promise<string>;
export const desktopUnitName: string;
export const desktopAppId: string;
export function formatDesktopStatus(status: any, backup?: any): string;
