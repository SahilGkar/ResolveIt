import type { AgentEvent } from '../../../src/index.js';

export class RunEventScope {
  private closed = false;
  private count = 0;

  constructor(private readonly sink: (event: AgentEvent) => void) {}

  handle = (event: AgentEvent): void => {
    if (this.closed) {
      return;
    }
    this.count += 1;
    this.sink(event);
  };

  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  eventCount(): number {
    return this.count;
  }
}
