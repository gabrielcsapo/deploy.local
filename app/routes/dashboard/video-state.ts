export function formatMediaDuration(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
export type MediaUploadState = { name: string; loaded: number; total: number; cancelled: boolean };
export function uploadProgress(state: MediaUploadState) {
  return state.cancelled
    ? 'Cancelled'
    : state.total > 0
      ? `${Math.min(100, Math.floor((state.loaded / state.total) * 100))}%`
      : 'Uploading…';
}
