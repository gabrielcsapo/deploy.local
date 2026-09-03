export type EndpointReadiness = 'starting' | 'ready' | 'unready' | 'draining';

export interface ServiceEndpointInput {
  id: string;
  serviceId: string;
  instanceId: string;
  host: string;
  port: number;
  releaseDigest: string;
  readiness: EndpointReadiness;
}

export interface ServiceEndpoint extends ServiceEndpointInput {
  inFlight: number;
  drainDeadline: number | null;
}

export interface EndpointSelectionOptions {
  /** Stable key for best-effort affinity. Omit for round-robin selection. */
  affinityKey?: string;
}

export interface EndpointLease {
  endpoint: Readonly<ServiceEndpoint>;
  release(): void;
}

export interface ServiceBackendLease {
  host: string;
  port: number;
  endpointId: string;
  release(): void;
}

/**
 * In-memory projection of durable endpoint membership. Membership replacement is atomic from a
 * request selector's perspective; only ready endpoints receive new HTTP or WebSocket requests.
 */
export class ServiceEndpointPool {
  readonly #services = new Map<string, Map<string, ServiceEndpoint>>();
  readonly #cursor = new Map<string, number>();

  replace(serviceId: string, endpoints: readonly ServiceEndpointInput[]): void {
    const previous = this.#services.get(serviceId);
    const next = new Map<string, ServiceEndpoint>();
    for (const endpoint of endpoints) {
      if (endpoint.serviceId !== serviceId) {
        throw new Error(
          `Endpoint ${JSON.stringify(endpoint.id)} belongs to ${JSON.stringify(endpoint.serviceId)}, not ${JSON.stringify(serviceId)}`,
        );
      }
      if (next.has(endpoint.id)) {
        throw new Error(`Duplicate endpoint identity ${JSON.stringify(endpoint.id)}`);
      }
      const existing = previous?.get(endpoint.id);
      if (existing) {
        const inFlight = existing.inFlight;
        const drainDeadline = endpoint.readiness === 'draining' ? existing.drainDeadline : null;
        Object.assign(existing, endpoint, { inFlight, drainDeadline });
        next.set(endpoint.id, existing);
      } else {
        next.set(endpoint.id, { ...endpoint, inFlight: 0, drainDeadline: null });
      }
    }
    this.#services.set(serviceId, next);
    const readyCount = [...next.values()].filter((item) => item.readiness === 'ready').length;
    this.#cursor.set(
      serviceId,
      readyCount === 0 ? 0 : (this.#cursor.get(serviceId) ?? 0) % readyCount,
    );
  }

  upsert(endpoint: ServiceEndpointInput): void {
    const service = this.#services.get(endpoint.serviceId) ?? new Map<string, ServiceEndpoint>();
    const existing = service.get(endpoint.id);
    service.set(endpoint.id, {
      ...endpoint,
      inFlight: existing?.inFlight ?? 0,
      drainDeadline: endpoint.readiness === 'draining' ? (existing?.drainDeadline ?? null) : null,
    });
    this.#services.set(endpoint.serviceId, service);
  }

  setReadiness(serviceId: string, endpointId: string, readiness: EndpointReadiness): void {
    const endpoint = this.requireEndpoint(serviceId, endpointId);
    endpoint.readiness = readiness;
    if (readiness !== 'draining') endpoint.drainDeadline = null;
  }

  beginDrain(serviceId: string, endpointId: string, deadline: number): void {
    const endpoint = this.requireEndpoint(serviceId, endpointId);
    endpoint.readiness = 'draining';
    endpoint.drainDeadline = deadline;
  }

  select(serviceId: string, options: EndpointSelectionOptions = {}): EndpointLease | null {
    const ready = [...(this.#services.get(serviceId)?.values() ?? [])]
      .filter((endpoint) => endpoint.readiness === 'ready')
      .sort((left, right) => left.id.localeCompare(right.id));
    if (ready.length === 0) return null;

    let endpoint: ServiceEndpoint;
    if (options.affinityKey !== undefined) {
      endpoint = ready[stableHash(options.affinityKey) % ready.length];
    } else {
      const cursor = this.#cursor.get(serviceId) ?? 0;
      endpoint = ready[cursor % ready.length];
      this.#cursor.set(serviceId, (cursor + 1) % ready.length);
    }
    endpoint.inFlight++;
    let released = false;
    return {
      endpoint: { ...endpoint },
      release: () => {
        if (released) return;
        released = true;
        endpoint.inFlight = Math.max(0, endpoint.inFlight - 1);
      },
    };
  }

  drainComplete(serviceId: string, endpointId: string, now = Date.now()): boolean {
    const endpoint = this.requireEndpoint(serviceId, endpointId);
    if (endpoint.readiness !== 'draining') return false;
    return (
      endpoint.inFlight === 0 || (endpoint.drainDeadline !== null && now >= endpoint.drainDeadline)
    );
  }

  removeDrained(serviceId: string, now = Date.now()): string[] {
    const service = this.#services.get(serviceId);
    if (!service) return [];
    const removed: string[] = [];
    for (const endpoint of service.values()) {
      if (
        endpoint.readiness === 'draining' &&
        (endpoint.inFlight === 0 ||
          (endpoint.drainDeadline !== null && now >= endpoint.drainDeadline))
      ) {
        service.delete(endpoint.id);
        removed.push(endpoint.id);
      }
    }
    return removed.sort();
  }

  snapshot(serviceId: string): ReadonlyArray<Readonly<ServiceEndpoint>> {
    return [...(this.#services.get(serviceId)?.values() ?? [])]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((endpoint) => ({ ...endpoint }));
  }

  private requireEndpoint(serviceId: string, endpointId: string): ServiceEndpoint {
    const endpoint = this.#services.get(serviceId)?.get(endpointId);
    if (!endpoint) {
      throw new Error(
        `Unknown service endpoint ${JSON.stringify(endpointId)} in ${JSON.stringify(serviceId)}`,
      );
    }
    return endpoint;
  }
}

/** Adapt a stable service pool to the edge proxy's optional backend lease contract. */
export function selectServiceBackend(
  pool: ServiceEndpointPool,
  serviceId: string,
  options: EndpointSelectionOptions = {},
): ServiceBackendLease | null {
  const lease = pool.select(serviceId, options);
  if (!lease) return null;
  return {
    host: lease.endpoint.host,
    port: lease.endpoint.port,
    endpointId: lease.endpoint.id,
    release: lease.release,
  };
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
