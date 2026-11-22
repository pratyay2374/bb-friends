import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { useFriends } from "../hooks/use-friends";
import { avatarImage, resolveAvatar } from "../lib/avatar";
import { describeFeed, describeStatus, sortMembers, timeAgo } from "../lib/describe";
import {
  AVATAR_STYLES, REACTIONS, formatRoomCode, type Avatar, type AvatarStyle, type FeedEntry, type Member,
} from "../lib/protocol";
import type { FriendsView } from "../lib/rpc";

const DOT = {
  busy: "bg-amber-500",
  idle: "bg-emerald-500",
  online: "bg-sky-500",
} as const;

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const AVATAR_LABELS: Record<AvatarStyle, string> = {
  "fun-emoji": "Fun Emoji",
  bottts: "Bottts",
  avataaars: "Avataaars",
  thumbs: "Thumbs",
};

function AvatarImage({ avatar: { style, seed }, size, label }: { avatar: Avatar; size: number; label?: string }) {
  const src = useMemo(() => avatarImage({ style, seed }), [style, seed]);
  return <img src={src} alt={label ?? ""} width={size} height={size} className="shrink-0 rounded-full bg-muted" />;
}

function AvatarSettings({ avatar, save }: { avatar: Avatar; save: (input: { style: AvatarStyle } | null) => Promise<unknown> }) {
  const [saving, setSaving] = useState(false);
  const update = async (input: Parameters<typeof save>[0]) => {
    setSaving(true);
    try {
      await save(input);
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="rounded-lg border border-border bg-card px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">Avatar settings</summary>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <AvatarImage avatar={avatar} size={48} label="Avatar preview" />
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Style
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={avatar.style}
            disabled={saving}
            onChange={(event) => void update({ style: event.target.value as AvatarStyle })}
          >
            {AVATAR_STYLES.map((style) => <option key={style} value={style}>{AVATAR_LABELS[style]}</option>)}
          </select>
        </label>
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void update(null)}>
          Reroll
        </Button>
      </div>
    </details>
  );
}

function Setup({
  view,
  run,
  rpc,
}: {
  view: FriendsView;
  run: (fn: () => Promise<unknown>) => void;
  rpc: ReturnType<typeof useFriends>["rpc"];
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(view.name);

  const withName = async (then: () => Promise<unknown>) => {
    if (name.trim() !== "" && name.trim() !== view.name) await rpc.call("setName", { name });
    await then();
  };
  const join = (event: FormEvent) => {
    event.preventDefault();
    run(() => withName(() => rpc.call("joinRoom", { code })));
  };
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Share an invite code with a friend. You only share whether you're busy or idle, the name of
        the bb project you're in, how many threads are running, and your provider. Never titles,
        prompts, file paths or code.
      </p>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">Your display name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
      </label>
      <Button onClick={() => run(() => withName(() => rpc.call("createRoom")))}>
        <Icon name="Plus" className="size-4" /> Create a room
      </Button>
      <form onSubmit={join} className="flex items-center gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Invite code, e.g. K7M2Q-9XWPA"
          aria-label="Invite code"
          className="font-mono"
        />
        <Button type="submit" variant="outline" disabled={code.trim() === ""}>
          Join
        </Button>
      </form>
    </div>
  );
}

function MemberRow({
  member,
  avatar,
  isYou,
  onPoke,
  onReact,
}: {
  member: Member;
  avatar: Avatar;
  isYou: boolean;
  onPoke: () => void;
  onReact: (emoji: (typeof REACTIONS)[number]) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
      <span
        className={cn("size-2.5 shrink-0 rounded-full", DOT[member.status.state])}
        aria-label={member.status.state}
      />
      <AvatarImage avatar={avatar} size={32} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">
          {member.name}
          {isYou ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">you</span> : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">{describeStatus(member.status)}</div>
      </div>
      {isYou ? null : picking ? (
        <div className="flex gap-0.5">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="rounded px-1 py-0.5 text-base hover:bg-muted"
              onClick={() => {
                setPicking(false);
                onReact(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setPicking(true)} aria-label={`React to ${member.name}`}>
            🙂
          </Button>
          <Button variant="outline" size="sm" onClick={onPoke}>
            👉 Poke
          </Button>
        </div>
      )}
    </li>
  );
}

function FeedRow({ entry, avatar, youId, onHighFive }: {
  entry: FeedEntry;
  avatar: Avatar;
  youId: string | null;
  onHighFive: () => void;
}) {
  return (
    <li className="flex items-center gap-2 px-4 py-2 text-xs">
      <AvatarImage avatar={avatar} size={24} />
      <span className="min-w-0 flex-1 truncate">{describeFeed(entry)}</span>
      {entry.kind === "done" && entry.whoId !== youId ? (
        <Button variant="ghost" size="sm" onClick={onHighFive}>
          🙌 High-five
        </Button>
      ) : null}
      <span className="shrink-0 text-muted-foreground">{timeAgo(entry.at, Date.now())}</span>
    </li>
  );
}

export function FriendsPage() {
  const { rpc, view, error, refetch } = useFriends();
  const [failure, setFailure] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) => {
    setFailure(null);
    fn().then(refetch, (cause: unknown) => setFailure(message(cause)));
  };
  const quiet = (fn: () => Promise<unknown>) => fn().catch((cause: unknown) => toast.error(message(cause)));

  const membersById = new Map(view?.members.map((member) => [member.id, member]));

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-2xl space-y-5 px-4 pb-6 pt-4 md:px-5">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-semibold">Friends</h1>
          {view && (
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <AvatarImage avatar={view.avatar} size={32} />
              <span className="truncate">{view.name}</span>
            </div>
          )}
        </header>
        {view && (
          <AvatarSettings avatar={view.avatar} save={(input) => quiet(async () => {
            await rpc.call("setAvatar", input);
            await refetch();
          })} />
        )}
        {view === null ? (
          <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>
        ) : view.room === null ? (
          <Setup view={view} run={run} rpc={rpc} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <code className="rounded bg-muted px-2 py-1 font-mono">{formatRoomCode(view.room)}</code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(formatRoomCode(view.room!));
                  toast("Invite code copied");
                }}
              >
                <Icon name="Copy" className="size-4" /> Copy
              </Button>
              <span className="text-xs text-muted-foreground">
                {view.connection === "connected"
                  ? "Live"
                  : view.connection === "connecting"
                    ? "Connecting…"
                    : "Disconnected, retrying"}
              </span>
              <Button className="ml-auto" variant="ghost" size="sm" onClick={() => run(() => rpc.call("leaveRoom"))}>
                Leave
              </Button>
            </div>
            {view.error ? <p role="alert" className="text-sm text-destructive">{view.error}</p> : null}

            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {view.members.length === 0 ? (
                <li className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {view.connection === "connected" ? "Nobody here yet." : "Waiting for the server…"}
                </li>
              ) : (
                sortMembers(view.members).map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    avatar={member.id === view.you ? view.avatar : resolveAvatar(member.avatar, member.id)}
                    isYou={member.id === view.you}
                    onPoke={() => void quiet(() => rpc.call("poke", { to: member.id }))}
                    onReact={(emoji) => void quiet(() => rpc.call("react", { to: member.id, emoji }))}
                  />
                ))
              )}
            </ul>

            <section className="space-y-2">
              <h2 className="text-sm font-medium">Activity</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {view.feed.length === 0 ? (
                  <li className="px-4 py-4 text-center text-xs text-muted-foreground">Nothing yet.</li>
                ) : (
                  [...view.feed].reverse().map((entry) => (
                    <FeedRow
                      key={entry.id}
                      entry={entry}
                      avatar={entry.whoId === view.you
                        ? view.avatar
                        : resolveAvatar(membersById.get(entry.whoId)?.avatar ?? entry.avatar, entry.whoId)}
                      youId={view.you}
                      onHighFive={() => void quiet(() => rpc.call("react", { to: entry.whoId, emoji: "🙌" }))}
                    />
                  ))
                )}
              </ul>
            </section>
          </>
        )}
        {failure ? <p role="alert" className="text-sm text-destructive">{failure}</p> : null}
      </div>
    </div>
  );
}
