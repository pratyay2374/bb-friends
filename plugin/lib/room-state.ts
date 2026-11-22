import { LIMITS, type FeedEntry, type Member, type ServerMessage } from "./protocol";

export type ConnectionState = "disconnected" | "connecting" | "connected";

/** Everything the panel renders. Rebuilt purely from server frames. */
export interface RoomView {
  connection: ConnectionState;
  /** Our own public member id in this room. */
  you: string | null;
  members: Member[];
  feed: FeedEntry[];
  error: string | null;
}

export const emptyView = (connection: ConnectionState = "disconnected"): RoomView => ({
  connection,
  you: null,
  members: [],
  feed: [],
  error: null,
});

/** Applies one server frame. Pokes and reactions are events, not state. */
export function applyServerMessage(view: RoomView, message: ServerMessage): RoomView {
  switch (message.t) {
    case "welcome":
      return {
        ...view,
        connection: "connected",
        you: message.you,
        members: message.members,
        feed: message.feed.slice(-LIMITS.feedSize),
        error: null,
      };
    case "member": {
      const exists = view.members.some((m) => m.id === message.member.id);
      return {
        ...view,
        members: exists
          ? view.members.map((m) => (m.id === message.member.id ? message.member : m))
          : [...view.members, message.member],
      };
    }
    case "left":
      return { ...view, members: view.members.filter((m) => m.id !== message.id) };
    case "feed":
      return {
        ...view,
        feed: [...view.feed.filter((e) => e.id !== message.entry.id), message.entry].slice(
          -LIMITS.feedSize,
        ),
      };
    case "error":
      return { ...view, error: message.message };
    case "poke":
    case "react":
      return view;
  }
}
