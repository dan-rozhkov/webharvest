interface HostState {
  active: number;
  pending: number;
  lastStart: number;
  waiting: (() => void)[];
}

export interface DomainQueueOptions {
  maxConcurrent?: number;
  minIntervalMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DomainQueue {
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private readonly hosts = new Map<string, HostState>();

  constructor(opts: DomainQueueOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.minIntervalMs = opts.minIntervalMs ?? 500;
  }

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const state = this.hosts.get(host) ?? { active: 0, pending: 0, lastStart: 0, waiting: [] };
    this.hosts.set(host, state);
    state.pending++;

    try {
      for (;;) {
        if (state.active >= this.maxConcurrent) {
          await new Promise<void>((resolve) => state.waiting.push(resolve));
          continue;
        }

        const since = Date.now() - state.lastStart;
        if (since < this.minIntervalMs) {
          await sleep(this.minIntervalMs - since);
          continue;
        }

        break;
      }

      state.active++;
      state.lastStart = Date.now();
      try {
        return await fn();
      } finally {
        state.active--;
        state.waiting.shift()?.();
      }
    } finally {
      state.pending--;
      if (state.active === 0 && state.waiting.length === 0 && state.pending === 0) {
        this.hosts.delete(host);
      }
    }
  }
}
