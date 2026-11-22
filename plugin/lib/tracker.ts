import type { ThreadFacts } from "./status";

/** Copies only the whitelisted fields, so nothing else is ever retained. */
export function toFacts(thread: ThreadFacts, status = thread.status): ThreadFacts {
  return {
    id: thread.id,
    status,
    projectId: thread.projectId,
    providerId: thread.providerId,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
    visibility: thread.visibility,
    parentThreadId: thread.parentThreadId,
  };
}

/** In-memory view of bb's threads, fed by events and one startup listing. */
export class ThreadTracker {
  private readonly threads = new Map<string, ThreadFacts>();
  private readonly activeSince = new Map<string, number>();

  upsert(thread: ThreadFacts, status?: string): void {
    this.threads.set(thread.id, toFacts(thread, status));
  }

  remove(id: string): void {
    this.threads.delete(id);
    this.activeSince.delete(id);
  }

  facts(): ThreadFacts[] {
    return [...this.threads.values()];
  }

  markActive(id: string, now: number): void {
    if (!this.activeSince.has(id)) this.activeSince.set(id, now);
  }

  /** How long the thread had been running, or null if we never saw it start. */
  finish(id: string, now: number): number | null {
    const since = this.activeSince.get(id);
    this.activeSince.delete(id);
    return since === undefined ? null : now - since;
  }
}
