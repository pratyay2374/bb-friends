import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";

import { CHANNEL_CHANGED, type FriendsView, type rpcContract } from "../lib/rpc";

/** The room view, refetched whenever the server publishes a change. */
export function useFriends() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<FriendsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    return rpc.call("state").then(
      (next) => {
        setView(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  useEffect(() => { void refetch(); }, [refetch]);
  useRealtime(CHANNEL_CHANGED, refetch);
  return { rpc, view, error, refetch };
}
