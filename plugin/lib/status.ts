import { LIMITS, type Status } from "./protocol";

/**
 * The ONLY thread fields status derivation reads. Titles, prompts, paths,
 * environments and message content are deliberately absent from this type, so
 * they cannot reach a `Status` even by accident. (A full bb thread DTO is
 * assignable to it; extra fields are simply never touched.)
 */
export interface ThreadFacts {
  id: string;
  status: string;
  projectId: string;
  providerId: string;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
  visibility: string;
  parentThreadId: string | null;
}

export interface DeriveOptions {
  /** projectId -> project display name. */
  projectNames: ReadonlyMap<string, string>;
  /** When false, project and provider are withheld (state + count only). */
  shareDetails: boolean;
}

/** Thread states that mean "an agent is working right now". */
const RUNNING = new Set(["active", "starting"]);

const isLive = (t: ThreadFacts): boolean =>
  t.archivedAt === null && t.deletedAt === null && t.visibility === "visible";

/**
 * busy   = at least one visible thread is running
 * idle   = visible threads exist but none is running
 * online = bb is open and there are no threads at all
 */
export function deriveStatus(
  threads: Iterable<ThreadFacts>,
  { projectNames, shareDetails }: DeriveOptions,
): Status {
  const live = [...threads].filter(isLive);
  const running = live.filter((t) => RUNNING.has(t.status));
  const focusPool = running.length > 0 ? running : live;
  const focus = focusPool.reduce<ThreadFacts | null>(
    (best, t) => (best === null || t.updatedAt > best.updatedAt ? t : best),
    null,
  );
  return {
    state: running.length > 0 ? "busy" : live.length > 0 ? "idle" : "online",
    project:
      shareDetails && focus ? (projectNames.get(focus.projectId) ?? null) : null,
    threads: Math.min(running.length, LIMITS.maxThreads),
    provider: shareDetails && focus ? focus.providerId : null,
  };
}
