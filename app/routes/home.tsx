import { Link } from 'react-flight-router/client';
import { AnimatedTerminal, DashboardPreview } from './home.client';
import { AuthAwareCTA } from '../components/AuthAwareCTA.client';

declare const __APP_VERSION__: string;

export default function Component() {
  return (
    <main className="relative overflow-hidden">
      {/* Hero — two-column on desktop, copy-left + terminal-right.
          Single column with terminal below copy on mobile. */}
      <section className="relative mesh-bg">
        <div className="absolute inset-0 grid-bg opacity-40 pointer-events-none" aria-hidden />
        <div className="relative max-w-6xl mx-auto px-6 pt-16 sm:pt-24 pb-20">
          <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_1fr] gap-10 lg:gap-14 items-center">
            {/* Left: copy */}
            <div>
              <div className="mb-5 flex flex-wrap items-center gap-2">
                <span className="pill-live">
                  <span className="font-mono uppercase tracking-wider text-[10px]">
                    self-hosted · v{__APP_VERSION__}
                  </span>
                </span>
                <a
                  href="https://github.com/gabrielcsapo/deploy.local"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-white/10 bg-bg-surface/60 backdrop-blur-sm text-text-secondary hover:text-text hover:ring-white/20 transition-colors"
                >
                  <IconGithub />
                  Star on GitHub
                </a>
              </div>

              <h1 className="text-4xl sm:text-5xl md:text-[3.5rem] font-semibold tracking-tight leading-[1.05] mb-5">
                Ship to your <span className="gradient-text">own metal.</span>
              </h1>

              <p className="text-base sm:text-lg text-text-secondary leading-relaxed max-w-[52ch] mb-8">
                No cloud, no per-seat pricing, no vendor lock-in. Push code, get a URL on a
                machine you control. Runs on any Linux box that can run Docker.
              </p>

              <div className="flex flex-wrap gap-3 mb-8">
                <AuthAwareCTA />
                <Link to="/docs" className="btn">
                  Read the docs
                </Link>
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-mono text-text-tertiary">
                <span>Node 22+</span>
                <span className="opacity-40">·</span>
                <span>Docker 24+</span>
                <span className="opacity-40">·</span>
                <span>SQLite</span>
                <span className="opacity-40">·</span>
                <span>mDNS + self-signed CA</span>
              </div>
            </div>

            {/* Right: terminal */}
            <div className="lg:pl-2">
              <AnimatedTerminal />
            </div>
          </div>
        </div>
      </section>

      {/* Feature grid */}
      <section className="relative max-w-6xl mx-auto px-6 py-20 sm:py-24">
        <div className="mb-12">
          <p className="eyebrow mb-2">Why deploy.local</p>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight max-w-[28ch]">
            A PaaS, on hardware you already own.
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5">
          <FeatureCard
            icon={<IconBolt />}
            title="Push and serve"
            body="Run `deploy` from any project directory. The CLI auto-detects Node, Docker, or static sites and gives you a *.local URL in seconds."
          />
          <FeatureCard
            icon={<IconShield />}
            title="Yours, end to end"
            body="SQLite on disk, self-signed CA, mDNS resolution. No cloud roundtrip, no external dependencies, no per-seat bill ever."
          />
          <FeatureCard
            icon={<IconActivity />}
            title="Observability that's actually real"
            body="Per-app RPS, p95, CPU, memory, and error rate on one screen. Logs, metrics, build history, and a deploy timeline included."
          />
        </div>
      </section>

      {/* Dashboard preview strip */}
      <section className="relative max-w-6xl mx-auto px-6 pb-24 sm:pb-32">
        <DashboardPreview />
      </section>

      {/* Bottom CTA */}
      <section className="relative max-w-4xl mx-auto px-6 pb-24 sm:pb-32">
        <div className="card-hero p-8 sm:p-12 text-center">
          <p className="eyebrow mb-3">Ready to ship?</p>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-4">
            One command. Your server. Done.
          </h2>
          <p className="text-text-secondary max-w-[52ch] mx-auto mb-7">
            Install the CLI, point it at any project, and watch it appear on your dashboard.
            Free, MIT-licensed, self-contained.
          </p>
          <pre className="inline-block text-left rounded-lg border border-white/[0.06] bg-bg/80 px-4 py-3 text-sm font-mono text-text-secondary mb-3 backdrop-blur-sm">
            <code>
              <span className="text-text-tertiary">$ </span>
              <span className="text-text">curl -fsSL deploy.local/install | sh</span>
            </code>
          </pre>
          <p className="text-[11px] text-text-tertiary mb-7">
            Run on the Linux box you want to host on — not your laptop.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <AuthAwareCTA />
            <a
              href="https://github.com/gabrielcsapo/deploy.local"
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
            >
              <IconGithub />
              Star on GitHub
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="group relative card p-5 sm:p-6 transition-colors hover:border-border-hover">
      <div className="mb-4 inline-flex items-center justify-center w-10 h-10 rounded-lg border border-white/[0.06] bg-bg/60 text-accent">
        {icon}
      </div>
      <h3 className="text-base font-semibold tracking-tight mb-1.5">{title}</h3>
      <p className="text-sm text-text-secondary leading-relaxed">{body}</p>
      <div
        className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        aria-hidden
        style={{
          background:
            'radial-gradient(ellipse 80% 80% at 0% 0%, hsl(266 90% 66% / 0.1), transparent 60%)',
        }}
      />
    </div>
  );
}

function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
      <path d="M13 3 4 14h7l-1 7 9-11h-7l1-7Z" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
      <path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3Z" strokeLinejoin="round" />
      <path d="m9 12 2 2 4-4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function IconActivity() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
      <path
        d="M3 12h4l3-8 4 16 3-8h4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconGithub() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="size-4">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
