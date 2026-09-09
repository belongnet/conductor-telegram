import type {CloudEngine} from "./engine.js";
import {ConductorApiError} from "../integrations/conductor-api.js";

/** Persistent due times with independent workers; a slow workspace never owns a whole polling cycle. */
export class CloudPoller {
  private readonly running = new Map<string, Promise<void>>();
  constructor(readonly engine: CloudEngine, readonly concurrency = 4) {}
  tick(now = Date.now()): void {
    const store = this.engine.store;
    const due = store.bindings().filter(({id}) => !this.running.has(id) && (store.get<number>(`poll-after:${id}`) ?? 0) <= now)
      .sort((a, b) => (store.get<number>(`poll-success:${a.id}`) ?? 0) - (store.get<number>(`poll-success:${b.id}`) ?? 0));
    for (const {id, binding} of due.slice(0, Math.max(0, this.concurrency - this.running.size))) {
      const task = Promise.resolve().then(async () => {
        try {
          await this.engine.pollWorkspace(id, binding);
          store.set("cloud-poll-last-success", Date.now());
        } catch (error) {
          store.set(`poll-error:${id}`, Date.now());
          store.set(`poll-after:${id}`, Date.now() + Math.max(15_000, error instanceof ConductorApiError ? error.retryAfterMs : 0));
        }
      }).catch(() => { /* Lease loss fences writes and is handled by the runtime. */ })
        .finally(() => this.running.delete(id));
      this.running.set(id, task);
    }
  }
  async settled(): Promise<void> { await Promise.all(this.running.values()); }
}
