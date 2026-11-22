import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { AVATAR_SEED_PATTERN, AVATAR_STYLES, LIMITS, REACTIONS, STATES } from "./protocol";

const statusSchema = z.object({
  state: z.enum(STATES),
  project: z.string().nullable(),
  threads: z.number().int(),
  provider: z.string().nullable(),
});

const avatarStyleSchema = z.enum(AVATAR_STYLES);
const avatarSchema = z.object({ style: avatarStyleSchema, seed: z.string().regex(AVATAR_SEED_PATTERN) });

const memberSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: statusSchema,
  avatar: avatarSchema.optional(),
  since: z.number(),
});

const feedEntrySchema = z.object({
  id: z.number(),
  at: z.number(),
  kind: z.enum(["joined", "left", "busy", "idle", "poke", "react", "done"]),
  who: z.string(),
  whoId: z.string(),
  avatar: avatarSchema.optional(),
  target: z.string().optional(),
  targetId: z.string().optional(),
  emoji: z.string().optional(),
});

export const viewSchema = z.object({
  connection: z.enum(["disconnected", "connecting", "connected"]),
  room: z.string().nullable(),
  you: z.string().nullable(),
  name: z.string(),
  serverUrl: z.string(),
  avatar: avatarSchema,
  members: z.array(memberSchema),
  feed: z.array(feedEntrySchema),
  error: z.string().nullable(),
});
export type FriendsView = z.infer<typeof viewSchema>;

const memberId = z.string().min(1).max(32);

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: viewSchema },
  createRoom: { input: z.null(), output: z.object({ code: z.string() }) },
  joinRoom: {
    input: z.object({ code: z.string().max(40) }).strict(),
    output: z.object({ code: z.string() }),
  },
  leaveRoom: { input: z.null(), output: z.object({ left: z.boolean() }) },
  setName: {
    input: z.object({ name: z.string().max(LIMITS.nameMax * 4) }).strict(),
    output: z.object({ name: z.string() }),
  },
  setAvatar: {
    input: z.union([z.object({ style: avatarStyleSchema }).strict(), z.null()]),
    output: avatarSchema,
  },
  poke: { input: z.object({ to: memberId }).strict(), output: z.object({ sent: z.boolean() }) },
  react: {
    input: z.object({ to: memberId, emoji: z.enum(REACTIONS) }).strict(),
    output: z.object({ sent: z.boolean() }),
  },
});

/** Realtime channels the frontend subscribes to. */
export const CHANNEL_CHANGED = "friends-changed";
export const CHANNEL_POKE = "friends-poke";
export const CHANNEL_REACT = "friends-react";
export const CHANNEL_NOTICE = "friends-notice";

export interface PokePayload { fromName: string; at: number }
export interface ReactPayload { fromName: string; emoji: string; at: number }
export interface NoticePayload { message: string }
