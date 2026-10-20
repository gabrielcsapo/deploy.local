'use client';
import { useState } from 'react';
import type { Attachment } from './attachment-state';
import { formatMediaDuration } from './video-state';
/** Same-origin account cookie authenticates every metadata and seek request. */
export function VideoPoster({ attachment, open }: { attachment: Attachment; open: () => void }) {
  const [duration, setDuration] = useState(attachment.duration);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="pw-media-open pw-video-poster"
      onClick={open}
      aria-label={`Play ${attachment.name}`}
    >
      <video
        src={`/api/workspace/attachments/${attachment.id}`}
        preload="metadata"
        muted
        playsInline
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(video.duration);
          if (video.duration > 0.1) video.currentTime = 0.1;
        }}
        onError={() => setFailed(true)}
      />
      <span className="pw-video-badge">
        {failed ? 'Video unavailable' : `▶ ${formatMediaDuration(duration) || 'Video'}`}
      </span>
    </button>
  );
}
