// Keep these eager imports in the worker's original order. Screenshots already loads attachments.
import { screenshotWorker } from '../v2/screenshots.ts';
import { attachmentBytes } from '../v2/attachments.ts';
import {
  registerAttachmentBytesSource,
  registerScreenshotWorker,
} from '../workspace/media-ports.ts';

/** Called by the local process entry before recovery, listeners or task/screenshot ticks. */
export function wireLocalWorkerMedia() {
  registerScreenshotWorker(screenshotWorker);
  registerAttachmentBytesSource(attachmentBytes);
}
