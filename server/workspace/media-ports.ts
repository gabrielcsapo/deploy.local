import type { AttachmentBytesSource, ScreenshotWorker } from '../contracts/workspace-media.ts';

let screenshots: ScreenshotWorker | undefined;
let attachments: AttachmentBytesSource | undefined;

export function registerScreenshotWorker(provider: ScreenshotWorker) {
  screenshots = provider;
}

export function registerAttachmentBytesSource(provider: AttachmentBytesSource) {
  attachments = provider;
}

export function requireScreenshotWorker(processName: string): ScreenshotWorker {
  if (!screenshots) throw new Error(`ScreenshotWorker is not wired in ${processName}`);
  return screenshots;
}

export function requireAttachmentBytesSource(processName: string): AttachmentBytesSource {
  if (!attachments) throw new Error(`AttachmentBytesSource is not wired in ${processName}`);
  return attachments;
}
