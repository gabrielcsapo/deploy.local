'use client';
import { useEffect, useRef, useState } from 'react';
import { getAuth } from './detail/shared';
import { prepareVoiceAudio } from './voice-audio';
export function VoiceInput({
  onTranscript,
  contextKey,
}: {
  onTranscript: (text: string) => void;
  contextKey: string;
}) {
  const [available, setAvailable] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const callback = useRef(onTranscript);
  callback.current = onTranscript;
  const headers = (): Record<string, string> => {
    const auth = getAuth();
    return auth ? { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token } : {};
  };
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/workspace/transcription', { headers: headers(), signal: controller.signal })
      .then((r) => r.json())
      .then((r) => setAvailable(Boolean(r.available)))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setRecording(false);
    setBusy(false);
    setRequesting(false);
    setError('');
    return () => {
      // Read the latest recording generation, not a DOM ref captured at mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      request.current?.abort();
      if (recorder.current?.state === 'recording') recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, [contextKey]);
  useEffect(() => {
    if (!recording) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    const stop = setTimeout(() => recorder.current?.stop(), 120000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [recording]);
  async function start() {
    setError('');
    const current = ++generation.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
        throw new Error(
          'Voice recording is unavailable in this browser. Use the native app or a browser with microphone support.',
        );
      setBusy(true);
      setRequesting(true);
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation.current !== current) {
        audio.getTracks().forEach((t) => t.stop());
        return;
      }
      setRequesting(false);
      stream.current = audio;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      if (!mimeType)
        throw new Error('This browser does not support a compatible recording format.');
      const media = new MediaRecorder(audio, { mimeType });
      recorder.current = media;
      const chunks: Blob[] = [];
      media.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      media.onerror = () => {
        generation.current++;
        audio.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setBusy(false);
        setError('Recording failed. Please try again.');
      };
      media.onstop = async () => {
        audio.getTracks().forEach((t) => t.stop());
        if (generation.current !== current) return;
        setRecording(false);
        setBusy(true);
        request.current = new AbortController();
        try {
          const wav = await prepareVoiceAudio(new Blob(chunks, { type: mimeType }));
          if (generation.current !== current) return;
          const response = await fetch('/api/workspace/transcription', {
            method: 'POST',
            headers: { ...headers(), 'Content-Type': 'audio/wav' },
            body: wav,
            signal: request.current.signal,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Transcription failed.');
          if (generation.current === current) {
            if (result.text) callback.current(result.text);
            else setError('No speech detected. Try again.');
          }
        } catch (e) {
          if (generation.current === current)
            setError(e instanceof Error ? e.message : 'Transcription failed.');
        } finally {
          if (generation.current === current) setBusy(false);
        }
      };
      media.start();
      setRecording(true);
      setBusy(false);
    } catch (e) {
      stream.current?.getTracks().forEach((t) => t.stop());
      if (generation.current === current) {
        setBusy(false);
        setRequesting(false);
        setError(e instanceof Error ? e.message : 'Microphone unavailable.');
      }
    }
  }
  return (
    <div className="pw-voice">
      <button
        type="button"
        aria-label={
          recording
            ? 'Stop dictation'
            : requesting
              ? 'Waiting for microphone'
              : busy
                ? 'Transcribing voice'
                : 'Dictate message'
        }
        aria-pressed={recording}
        disabled={busy || !available}
        title={
          available
            ? 'Dictate a message · review before sending'
            : 'Voice input is not configured on this coordinator'
        }
        onClick={() => (recording ? recorder.current?.stop() : void start())}
      >
        {recording ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5.5 10.5v1a6.5 6.5 0 0 0 13 0v-1M12 18v3m-3 0h6" />
          </svg>
        )}
      </button>
      {(recording || busy) && (
        <span role="status" className="pw-voice-status">
          {recording ? `${elapsed}s` : requesting ? 'Allow microphone access…' : 'Transcribing…'}
        </span>
      )}
      {error && (
        <span role="alert" className="pw-voice-status" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
