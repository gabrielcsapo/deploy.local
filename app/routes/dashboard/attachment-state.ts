export type Attachment = {
  id: string;
  taskId: string;
  runId?: string;
  messageId?: string;
  kind: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  name: string;
  caption?: string;
  source: string;
  createdAt: string;
};
export function attachmentChips(
  current: Attachment[],
  action: { add: Attachment } | { remove: string },
) {
  return 'add' in action
    ? current.some((a) => a.id === action.add.id)
      ? current
      : [...current, action.add]
    : current.filter((a) => a.id !== action.remove);
}
export function restoreAttachmentDraft(raw: string | null): Attachment[] {
  try {
    const rows = JSON.parse(raw || '[]');
    return Array.isArray(rows)
      ? rows.filter((a) => typeof a?.id === 'string' && typeof a?.taskId === 'string')
      : [];
  } catch {
    return [];
  }
}

export function attachmentDraftKey(username: string, taskId: string) {
  return `workspace-media-${username}-${taskId || 'new'}`;
}
