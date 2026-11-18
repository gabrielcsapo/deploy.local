import type { IncomingMessage } from 'node:http';
import { get } from '../../workspace/store.ts';
import { streamAttachment } from '../../workspace/attachments.ts';
export async function uploadRecording(
  stream: AsyncIterable<Buffer | Uint8Array>,
  owner: string,
  workerId: string,
  sessionId: string,
  instanceId: string,
) {
  const session = get('interactive-session', owner, sessionId);
  if (session.workerId !== workerId || session.instanceId !== instanceId || !session.record)
    throw Object.assign(new Error('Recording is not assigned to this worker'), { status: 403 });
  return streamAttachment(stream, owner, session.taskId, {
    operationId: `recording:${session.id}`,
    name: 'recording.webm',
    kind: 'video',
    source: 'computer-use',
    caption: 'Computer use recording',
    runId: session.runId,
    sessionId: session.id,
    actionId: 'recording',
  });
}
export function recordingRequest(
  req: IncomingMessage,
  owner: string,
  workerId: string,
  sessionId: string,
) {
  return uploadRecording(
    req,
    owner,
    workerId,
    sessionId,
    String(req.headers['x-worker-instance'] || ''),
  );
}
