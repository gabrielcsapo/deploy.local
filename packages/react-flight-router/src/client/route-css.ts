/** Stage new sheets without applying them to the page that is still visible. */
export async function prepareStylesheets(files: string[], order: string[]) {
  const created: HTMLLinkElement[] = [];
  const links = new Map<string, HTMLLinkElement>();
  const cancelLoads: (() => void)[] = [];
  const dispose = () => {
    for (const cancel of cancelLoads) cancel();
    for (const link of created) link.remove();
  };
  try {
    await Promise.all(
      files.map(async (href) => {
        const existing = [
          ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
        ].find(
          (link) => link.getAttribute('href') === href && link.media !== 'not all' && link.sheet,
        );
        if (existing) {
          links.set(href, existing);
          return;
        }
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.media = 'not all';
        created.push(link);
        links.set(href, link);
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            link.onload = link.onerror = null;
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(() => finish(new Error(`Stylesheet timed out: ${href}`)), 15000);
          cancelLoads.push(() =>
            finish(new DOMException('Stylesheet preparation cancelled', 'AbortError')),
          );
          link.onload = () => finish();
          link.onerror = () => finish(new Error(`Failed to load stylesheet: ${href}`));
          // Inactive sheets can take their final place now. Moving a link later would make the
          // browser reapply it, which can flash unstyled content.
          const rank = order.indexOf(href);
          const next =
            rank < 0
              ? undefined
              : [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find(
                  (other) => order.indexOf(other.getAttribute('href') ?? '') > rank,
                );
          if (next) next.before(link);
          else document.head.appendChild(link);
        });
      }),
    );
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    dispose,
    commit() {
      const owned = new Set(order);
      // Includes Vite-inserted links as well as SSR links. Leave application-owned
      // links outside the build manifest alone. Remove duplicates and old routes.
      for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
        const href = link.getAttribute('href') ?? '';
        if (owned.has(href) && link.media !== 'not all' && links.get(href) !== link) link.remove();
      }
      for (const href of files) links.get(href)!.media = '';
    },
  };
}
