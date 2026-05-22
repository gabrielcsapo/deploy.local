'use client';

import { useEffect, useState } from 'react';

/**
 * Self-driving terminal that mirrors a real `deploy` run. The script —
 * Bundling, Uploading (with a live percentage), Building (with streaming
 * docker output), Build Success, Starting container, Deployed, and the
 * final URL — comes verbatim from bin/deploy.js's console output, so
 * what visitors see on the home page is what they actually get when
 * they run the binary. Pure client animation; no network calls.
 */
type Line =
  | { kind: 'cmd'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'progress'; bytes: number; total: number; speed: number }
  | { kind: 'build'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'url'; text: string };

interface Step {
  /** ms to wait before emitting the next line */
  delay: number;
  /** Either append a new line or rewrite the most recent one (used for the
      Uploading progress line, which the real CLI overwrites with \r). */
  replaceLast?: boolean;
  line: Line;
}

const SCRIPT: Step[] = [
  { delay: 600, line: { kind: 'cmd', text: 'deploy my-app' } },
  { delay: 500, line: { kind: 'info', text: 'Bundling my-app...' } },
  {
    delay: 350,
    line: { kind: 'progress', bytes: 0.6, total: 4.8, speed: 1.2 },
  },
  {
    delay: 220,
    replaceLast: true,
    line: { kind: 'progress', bytes: 1.6, total: 4.8, speed: 1.4 },
  },
  {
    delay: 200,
    replaceLast: true,
    line: { kind: 'progress', bytes: 2.7, total: 4.8, speed: 1.4 },
  },
  {
    delay: 200,
    replaceLast: true,
    line: { kind: 'progress', bytes: 3.9, total: 4.8, speed: 1.5 },
  },
  {
    delay: 200,
    replaceLast: true,
    line: { kind: 'progress', bytes: 4.8, total: 4.8, speed: 1.5 },
  },
  { delay: 350, line: { kind: 'info', text: 'Building...' } },
  { delay: 320, line: { kind: 'build', text: '#1 [internal] load build definition' } },
  { delay: 260, line: { kind: 'build', text: '#2 [internal] load .dockerignore' } },
  { delay: 300, line: { kind: 'build', text: '#3 [1/5] FROM node:22-alpine' } },
  { delay: 380, line: { kind: 'build', text: '#4 [2/5] COPY package.json pnpm-lock.yaml ./' } },
  { delay: 420, line: { kind: 'build', text: '#5 [3/5] RUN pnpm install --frozen-lockfile' } },
  { delay: 480, line: { kind: 'build', text: '#6 [4/5] COPY . .' } },
  { delay: 360, line: { kind: 'build', text: '#7 [5/5] RUN pnpm build' } },
  { delay: 360, line: { kind: 'success', text: 'Build Success (12.4s)' } },
  { delay: 360, line: { kind: 'info', text: 'Starting container...' } },
  { delay: 700, line: { kind: 'info', text: 'Deployed my-app' } },
  { delay: 220, line: { kind: 'url', text: '  URL: https://my-app.local' } },
];

const RESTART_PAUSE_MS = 4200;

export function AnimatedTerminal() {
  const [lines, setLines] = useState<Line[]>([]);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (step >= SCRIPT.length) {
      // Hold on the final state, then reset and loop.
      const t = setTimeout(() => {
        setLines([]);
        setStep(0);
      }, RESTART_PAUSE_MS);
      return () => clearTimeout(t);
    }
    const next = SCRIPT[step];
    const t = setTimeout(() => {
      setLines((prev) => {
        if (next.replaceLast && prev.length > 0) {
          return [...prev.slice(0, -1), next.line];
        }
        return [...prev, next.line];
      });
      setStep((s) => s + 1);
    }, next.delay);
    return () => clearTimeout(t);
  }, [step]);

  const isFinished = step >= SCRIPT.length;

  return (
    <div className="relative">
      <div className="card-hero p-5 sm:p-6 font-mono text-[13px] leading-relaxed">
        {/* Window chrome */}
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/5">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-danger/70" aria-hidden />
            <span className="w-2.5 h-2.5 rounded-full bg-warning/70" aria-hidden />
            <span className="w-2.5 h-2.5 rounded-full bg-success/70" aria-hidden />
          </div>
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
            ~/my-app
          </div>
          <div className="w-12" aria-hidden />
        </div>

        {/* Output — fixed-height region so the card doesn't jump while the
            script types itself out. Each line type has its own renderer
            since the real CLI prints them with different colors/glyphs. */}
        <div className="min-h-[260px] flex flex-col gap-0.5">
          {lines.map((l, i) => (
            <TerminalLine key={i} line={l} />
          ))}
          {/* Blinking caret on a fresh prompt once the run completes */}
          {isFinished && (
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-accent-2">$</span>
              <span className="inline-block w-[7px] h-[14px] -mb-0.5 bg-text animate-caret align-middle" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TerminalLine({ line }: { line: Line }) {
  switch (line.kind) {
    case 'cmd':
      return (
        <div className="flex items-baseline gap-2">
          <span className="text-accent-2">$</span>
          <span className="text-text">{line.text}</span>
        </div>
      );
    case 'info':
      return <div className="text-text">{line.text}</div>;
    case 'progress': {
      const pct = (line.bytes / line.total) * 100;
      return (
        <div className="text-text-secondary">
          Uploading... {line.bytes.toFixed(1)} MB / {line.total.toFixed(1)} MB ({pct.toFixed(1)}%)
          {' - '}
          {line.speed.toFixed(1)} MB/s
        </div>
      );
    }
    case 'build':
      return <div className="text-text-tertiary">{line.text}</div>;
    case 'success':
      return (
        <div className="mt-1">
          Build <span className="text-success">Success</span>{' '}
          <span className="text-text-tertiary">(12.4s)</span>
        </div>
      );
    case 'url':
      return (
        <div className="text-text">
          {'  URL: '}
          <a
            href="https://my-app.local"
            className="text-accent hover:text-accent-hover transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            https://my-app.local
          </a>
        </div>
      );
  }
}

/**
 * Static dashboard preview strip — composed inline with real-feeling data
 * so visitors see what they're getting. Kept purely visual; no network
 * calls, no live data. Sits below the hero as a single "screenshot" tile.
 */
export function DashboardPreview() {
  return (
    <div className="relative mt-20 sm:mt-24">
      {/* Edge glow halo */}
      <div
        className="absolute -inset-x-6 -inset-y-10 -z-10 opacity-60"
        aria-hidden
        style={{
          background:
            'radial-gradient(ellipse 60% 70% at 50% 50%, hsl(266 90% 60% / 0.18), transparent 70%)',
          filter: 'blur(20px)',
        }}
      />

      <div className="text-center mb-8">
        <p className="eyebrow mb-2">The dashboard</p>
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight">
          See every deploy, every request, every server.
        </h2>
      </div>

      <div className="card-hero overflow-hidden">
        {/* Faux window chrome */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-danger/70" aria-hidden />
            <span className="w-2.5 h-2.5 rounded-full bg-warning/70" aria-hidden />
            <span className="w-2.5 h-2.5 rounded-full bg-success/70" aria-hidden />
          </div>
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary font-mono">
            deploy.local/dashboard
          </div>
          <div className="w-12" aria-hidden />
        </div>

        {/* Body — two-column with a tiny sidebar */}
        <div className="grid grid-cols-[140px_1fr] divide-x divide-white/[0.04]">
          <div className="p-4 hidden sm:block">
            <p className="eyebrow mb-3">Fleet</p>
            <ul className="space-y-1 text-sm">
              <li className="flex items-center gap-2 py-1.5 px-2 rounded-md bg-accent/10 text-text">
                <span className="w-1 h-1 rounded-full bg-accent" aria-hidden />
                Overview
              </li>
              <li className="flex items-center gap-2 py-1.5 px-2 rounded-md text-text-tertiary">
                Apps
              </li>
              <li className="flex items-center gap-2 py-1.5 px-2 rounded-md text-text-tertiary">
                Activity
              </li>
            </ul>
            <p className="eyebrow mt-5 mb-3">Account</p>
            <ul className="space-y-1 text-sm">
              <li className="flex items-center gap-2 py-1.5 px-2 rounded-md text-text-tertiary">
                Settings
              </li>
            </ul>
          </div>

          <div className="p-4 sm:p-6">
            {/* Fleet strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              <PreviewStat label="Apps" value="6/6" sub="all healthy" />
              <PreviewStat label="Req/s" value="42.7" sub="1,169 in last min" />
              <PreviewStat label="Error rate" value="0.0%" sub="5xx, last 60s" />
              <PreviewStat label="Resources" value="38%" sub="2.1 GB · 5%" />
            </div>

            {/* Mini sparkline strip */}
            <div className="rounded-lg border border-white/5 bg-bg/40 p-4 mb-5">
              <div className="flex items-center justify-between mb-3">
                <p className="eyebrow">Fleet traffic</p>
                <span className="text-[10px] font-mono text-text-tertiary">6h</span>
              </div>
              <PreviewSparkline />
            </div>

            {/* Per-app rows */}
            <div className="rounded-lg border border-white/5 overflow-hidden">
              <PreviewRow name="medius" status="healthy" rps="12.4" />
              <PreviewRow name="gardeneus" status="healthy" rps="8.1" />
              <PreviewRow name="compendus" status="healthy" rps="6.3" last />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-bg/40 p-3">
      <p className="eyebrow mb-1">{label}</p>
      <p className="font-mono text-xl font-semibold leading-none tabular-nums text-text">
        {value}
      </p>
      <p className="text-[10px] text-text-tertiary mt-1.5">{sub}</p>
    </div>
  );
}

function PreviewSparkline() {
  // Static-ish sparkline drawn as SVG. The data shape is hand-chosen to
  // look "alive" — a couple of peaks, a dip, a final rise.
  const data = [
    18, 22, 14, 19, 26, 30, 24, 18, 22, 32, 28, 20, 16, 24, 30, 34, 28, 22, 26, 30,
    36, 30, 24, 18, 22, 28, 32, 38, 30, 26, 22, 28, 34, 30, 26, 32, 38, 42,
  ];
  const max = Math.max(...data);
  const w = 100;
  const h = 60;
  const stepX = w / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * stepX).toFixed(2)},${(h - (v / max) * h * 0.92 - 2).toFixed(2)}`)
    .join(' ');
  const area = `0,${h} ${points} ${w},${h}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-[60px]">
      <defs>
        <linearGradient id="preview-spark-stroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="hsl(266 90% 66%)" />
          <stop offset="100%" stopColor="hsl(320 88% 66%)" />
        </linearGradient>
        <linearGradient id="preview-spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(266 90% 66% / 0.35)" />
          <stop offset="100%" stopColor="hsl(266 90% 66% / 0)" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#preview-spark-fill)" />
      <polyline
        points={points}
        fill="none"
        stroke="url(#preview-spark-stroke)"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function PreviewRow({
  name,
  status,
  rps,
  last,
}: {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  rps: string;
  last?: boolean;
}) {
  const dot =
    status === 'healthy' ? 'bg-success' : status === 'degraded' ? 'bg-warning' : 'bg-danger';
  return (
    <div
      className={`flex items-center justify-between px-3 py-2.5 ${
        last ? '' : 'border-b border-white/5'
      } bg-bg/30`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
        <div>
          <p className="text-sm text-text">{name}</p>
          <p className="text-[10px] font-mono text-text-tertiary">{name}.local</p>
        </div>
      </div>
      <div className="text-right">
        <p className="text-sm font-mono tabular-nums text-text-secondary">{rps}</p>
        <p className="text-[10px] font-mono text-text-tertiary">req/s</p>
      </div>
    </div>
  );
}
