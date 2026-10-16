import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Browser, BrowserContext, Page } from 'playwright';
const exec = promisify(execFile);
type Runtime = {
  context?: BrowserContext;
  page?: Page;
  session: any;
  busy: boolean;
  log: string[];
  inputBounds?: any;
};
export class InteractiveRunner {
  private browser?: Browser;
  private sessions = new Map<string, Runtime>();
  private polling = false;
  private inventoryAt = 0;
  private inventory: any[] = [];
  private closed = false;
  private invalid = new Set<string>();
  private lastPoll = Date.now();
  private timer: ReturnType<typeof setInterval>;
  private request: (action: string, body: any) => Promise<any>;
  constructor(request: (action: string, body: any) => Promise<any>) {
    this.request = request;
    // A worker losing its coordinator closes managed targets. Pending input is never replayed.
    this.timer = setInterval(() => {
      if (Date.now() - this.lastPoll > 5000) void this.closeTargets();
    }, 500);
    this.timer.unref();
  }
  private async desktop(body: any) {
    const executable = process.env.DEPLOY_DESKTOP_HELPER;
    if (!executable || process.platform !== 'darwin')
      throw new Error('macOS control helper is not configured');
    const { stdout } = await exec(executable, [JSON.stringify(body)], {
      timeout: 4000,
      maxBuffer: 1800000,
    });
    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);
    return result;
  }
  private async targets() {
    if (Date.now() - this.inventoryAt < 2000) return this.inventory;
    const targets: any[] = [];
    if (process.env.DEPLOY_BROWSER_CONTROL === '1') {
      const { chromium } = await import('playwright');
      const available = existsSync(chromium.executablePath());
      targets.push({
        id: 'managed-browser',
        kind: 'browser',
        label: 'Task browser',
        available,
        reason: available
          ? ''
          : 'Install the worker Chromium runtime: pnpm exec playwright install chromium',
      });
    }
    if (process.env.DEPLOY_DESKTOP_HELPER && process.platform === 'darwin') {
      try {
        targets.push(...(await this.desktop({ type: 'status' })).targets);
      } catch (error: any) {
        targets.push({
          id: 'desktop',
          kind: 'computer',
          label: 'Mac desktop',
          available: false,
          reason: error.message,
        });
      }
    }
    this.inventory = targets;
    this.inventoryAt = Date.now();
    return targets;
  }
  async tick() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const targets = await this.targets();
      const result = await this.request('poll', {
        targets,
        ready: [...this.sessions.values()]
          .filter((s) => !s.busy)
          .map((s) => ({ id: s.session.id, generation: s.session.generation })),
      });
      this.lastPoll = Date.now();
      for (const [key, runtime] of this.sessions) {
        if (!result.sessions.some((s: any) => s.id === key)) {
          await runtime.context?.close().catch(() => {});
          this.sessions.delete(key);
        }
      }
      for (const session of result.sessions) {
        if (this.invalid.has(session.id)) {
          await this.request('fail', {
            sessionId: session.id,
            error: 'Control connection or target was lost; start a new session',
          });
          continue;
        }
        let runtime = this.sessions.get(session.id);
        if (runtime?.busy) continue;
        if (!runtime) {
          runtime = { session, busy: false, log: [] };
          try {
            if (session.kind === 'browser') {
              const { chromium } = await import('playwright');
              this.browser ||= await chromium.launch({ headless: true });
              runtime.context = await this.browser.newContext({
                viewport: { width: 1280, height: 800 },
                acceptDownloads: false,
                serviceWorkers: 'block',
              });
              // No inherited cookies, credentials, permissions, or personal browser profile.
              await runtime.context.route('**/*', (route) => {
                const url = new URL(route.request().url());
                return ['http:', 'https:'].includes(url.protocol)
                  ? route.continue()
                  : route.abort();
              });
              runtime.page = await runtime.context.newPage();
              runtime.context.on('page', (page) => {
                if (page !== runtime!.page) void page.close();
              });
              runtime.page.setDefaultTimeout(1500);
              const log = (message: string) => {
                runtime!.log.push(message.slice(0, 500));
                if (runtime!.log.length > 40) runtime!.log.shift();
              };
              runtime.page.on('console', (message) =>
                log(`console ${message.type()}: ${message.text()}`),
              );
              runtime.page.on('response', (response) =>
                log(
                  `${response.status()} ${response.request().method()} ${response.url().split('?')[0]}`,
                ),
              );
              runtime.page.on('dialog', (dialog) => void dialog.dismiss());
            }
            this.sessions.set(session.id, runtime);
          } catch (error: any) {
            await runtime.context?.close().catch(() => {});
            await this.request('fail', { sessionId: session.id, error: error.message });
            continue;
          }
        }
        runtime.session = session;
        const entry = result.commands.find(
          (c: any) => c.sessionId === session.id && c.generation === session.generation,
        );
        if (entry) {
          runtime.busy = true;
          void this.execute(runtime, entry).finally(() => {
            runtime!.busy = false;
          });
        }
      }
    } catch {
      // Close on connection loss, even if the input command may already have completed.
      await this.closeTargets();
    } finally {
      this.polling = false;
    }
  }
  private async execute(runtime: Runtime, entry: any) {
    const identity = {
      sessionId: runtime.session.id,
      commandId: entry.id,
      generation: entry.generation,
    };
    let claimed = false;
    try {
      const claim = await this.request('claim', identity);
      if (claim.status !== 'running') return;
      claimed = true;
      if (
        this.closed ||
        !this.sessions.has(runtime.session.id) ||
        Date.now() - this.lastPoll > 5000
      )
        throw new Error('Control connection lost');
      const action = entry.args;
      let snapshot: any;
      if (runtime.session.kind === 'computer') {
        snapshot = await this.desktop({
          ...action,
          targetId: runtime.session.targetId,
          expectedBounds: runtime.inputBounds,
        });
        runtime.inputBounds = snapshot.inputBounds;
      } else {
        const page = runtime.page!;
        if (action.type === 'navigate')
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 4000 });
        else if (action.type === 'click')
          if (action.selector)
            await page.locator(action.selector).click({ timeout: 1500, noWaitAfter: true });
          else await page.mouse.click(action.x, action.y);
        else if (action.type === 'fill')
          await page.locator(action.selector).fill(action.text, { timeout: 1500 });
        else if (action.type === 'text') await page.keyboard.insertText(action.text);
        else if (action.type === 'press') await page.keyboard.press(action.key);
        else if (action.type === 'scroll') await page.mouse.wheel(action.x, action.y);
        snapshot = {
          url: page.url(),
          title: await page.title(),
          text: (await page.locator('body').ariaSnapshot({ timeout: 1500 })).slice(0, 32000),
          image: (await page.screenshot({ type: 'jpeg', quality: 55, timeout: 1500 })).toString(
            'base64',
          ),
          mimeType: 'image/jpeg',
          width: 1280,
          height: 800,
          log: runtime.log,
        };
      }
      await this.request('complete', { ...identity, snapshot });
    } catch (error: any) {
      if (claimed) {
        // Report uncertainty; never issue the input a second time after a timeout or lost reply.
        await this.request('complete', { ...identity, error: error.message }).catch(() => {});
        await runtime.context?.close().catch(() => {});
        this.invalid.add(runtime.session.id);
        this.sessions.delete(runtime.session.id);
      }
    }
  }
  private async closeTargets() {
    for (const runtime of this.sessions.values()) {
      this.invalid.add(runtime.session.id);
      await runtime.context?.close().catch(() => {});
    }
    this.sessions.clear();
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }
  async shutdown() {
    this.closed = true;
    clearInterval(this.timer);
    await this.closeTargets();
  }
}
