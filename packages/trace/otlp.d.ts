import type { InteractionEvent, interactionTracer } from './interaction.js';
export declare function exportInteractions(events: InteractionEvent[], service: string): object;
export declare function routeFamily(
  path: string,
  prefix: string,
  known: readonly string[],
): string | undefined;
export declare function observeWebFlows(
  tracer: ReturnType<typeof interactionTracer>,
  nameRequest: (path: string, method: string) => string | undefined,
): () => void;
export declare const navigationHandoffScript: string;
export declare function takeNavigationStart(scope?: string): number | undefined;
export declare function observeNavigation(
  tracer: ReturnType<typeof interactionTracer>,
  nameRoute: (path: string) => string | undefined,
  documentStart?: number,
): {
  take(path: string): import('./interaction.js').Interaction | undefined;
  committed(path: string): void;
  close(): void;
};
