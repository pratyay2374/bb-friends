import type { FeedEntry, Member, Status } from "./protocol";

/** "Working in bb · 2 threads · claude-code", built only from Status fields. */
export function describeStatus(status: Status): string {
  const parts: string[] = [];
  if (status.state === "busy") {
    parts.push(status.project ? `Working in ${status.project}` : "Working");
    parts.push(`${status.threads} thread${status.threads === 1 ? "" : "s"}`);
  } else if (status.state === "idle") {
    parts.push(status.project ? `Idle in ${status.project}` : "Idle");
  } else {
    parts.push("Online");
  }
  if (status.provider) parts.push(status.provider);
  return parts.join(" · ");
}

/** One-line sentence for an activity-feed entry. */
export function describeFeed(entry: FeedEntry): string {
  switch (entry.kind) {
    case "joined":
      return `${entry.who} joined`;
    case "left":
      return `${entry.who} left`;
    case "busy":
      return `${entry.who} got busy`;
    case "idle":
      return `${entry.who} went idle`;
    case "poke":
      return `${entry.who} poked ${entry.target ?? "someone"}`;
    case "react":
      return `${entry.who} sent ${entry.target ?? "someone"} ${entry.emoji ?? "a reaction"}`;
    case "done":
      return `${entry.who} finished a thread 🎉`;
  }
}

const RANK = { busy: 0, idle: 1, online: 2 } as const;

/** Busy first, then idle, then online; ties by name. */
export function sortMembers(members: Member[]): Member[] {
  return [...members].sort(
    (a, b) =>
      RANK[a.status.state] - RANK[b.status.state] || a.name.localeCompare(b.name),
  );
}

export function timeAgo(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
