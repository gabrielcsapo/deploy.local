import { randomUUID } from 'node:crypto';

// Use a fresh Playwright context for each trial. The caller provides its signed-in session.
export async function auditNavigation(page, options) {
  const {
    from,
    to,
    link,
    endpoint,
    service,
    root,
    event: milestone,
    settleMs = 0,
    exportWaitMs = 5000,
  } = options;
  const destination = new URL(to, from);
  const collector = new URL(endpoint, from);

  const marker = randomUUID();
  let click;
  const roots = new Map();
  function onConsole(message) {
    const text = message.text();
    if (text.startsWith(marker)) click = JSON.parse(text.slice(marker.length));
  }
  function onRequest(request) {
    if (request.url() !== collector.href || request.method() !== 'POST') return;
    let data;
    try {
      data = request.postDataJSON();
    } catch {
      return;
    }
    for (const resource of data?.resourceSpans ?? []) {
      const name = resource.resource?.attributes?.find((a) => a.key === 'service.name')?.value
        ?.stringValue;
      if (name !== service) continue;
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          if (
            span.name !== root ||
            span.parentSpanId ||
            !span.events?.some((e) => e.name === milestone)
          )
            continue;
          roots.set(span.traceId, Number(span.startTimeUnixNano) / 1e6);
        }
      }
    }
  }
  page.on('console', onConsole);
  page.on('request', onRequest);
  try {
    await page.addInitScript(
      ({ prefix, target }) => {
        if (window.top !== window) return;
        document.addEventListener(
          'click',
          (event) => {
            const a = event.target instanceof Element && event.target.closest('a[href]');
            if (
              !event.isTrusted ||
              event.button !== 0 ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              a?.href !== target
            )
              return;
            console.debug(
              prefix +
                JSON.stringify({
                  at: performance.timeOrigin + event.timeStamp,
                  document: performance.timeOrigin,
                }),
            );
          },
          true,
        );
      },
      { prefix: marker, target: destination.href },
    );
    // A streamed link can be actionable while the document is still loading.
    await page.goto(from, { waitUntil: 'commit' });
    const anchor = link(page);
    await anchor.waitFor({ state: 'visible' });
    if (settleMs) await page.waitForTimeout(settleMs);
    await anchor.click();
    await page.waitForURL(destination.href);
    await page.waitForTimeout(exportWaitMs);
    if (!click) throw new Error('The trusted click on the destination link was not observed.');
    const document = await page.evaluate(() => performance.timeOrigin);
    // Epoch milliseconds from DOM events and exported nanoseconds have different rounding.
    const traceIds = [...roots].filter(([, at]) => at >= click.at - 1).map(([id]) => id);
    return { navigation: document === click.document ? 'same-document' : 'new-document', traceIds };
  } finally {
    page.off('console', onConsole);
    page.off('request', onRequest);
  }
}
