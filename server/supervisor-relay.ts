/** Only fleet state is replayed; deployment notices are live broadcasts. */
export class SupervisorRelay {
  fleetLine: string | null = null;
  private broadcast: (line: string) => void;

  constructor(broadcast: (line: string) => void) {
    this.broadcast = broadcast;
  }

  receive(line: string) {
    try {
      const type = (JSON.parse(line) as { type?: string })?.type;
      if (type === 'fleet') this.fleetLine = line;
      if (type === 'fleet' || type === 'deployment') this.broadcast(line);
    } catch {
      // Malformed input must never affect supervision.
    }
  }
}
