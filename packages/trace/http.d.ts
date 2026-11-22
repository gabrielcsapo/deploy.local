export declare function startHttpSpan(
  parent: unknown,
): ((method: string, route: string, status: number) => object) | undefined;
export declare function httpBatch(service: string, spans: object[]): object;
export declare function bufferedExporter(
  send: (spans: object[]) => Promise<unknown>,
): (span: object) => void;
