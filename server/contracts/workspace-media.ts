/** Product media operations needed by the local task worker. No feature dependencies. */
export type ScreenshotWorker = (owner: string, workerId: string, action: string, body: any) => any;

export type AttachmentBytesSource = (
  owner: string,
  ref: string,
) => Promise<{ bytes: Buffer; type: string; markup?: any }>;
