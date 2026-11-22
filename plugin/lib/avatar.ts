import { createAvatar } from "@dicebear/core";
import * as avataaars from "@dicebear/avataaars";
import * as bottts from "@dicebear/bottts";
import * as funEmoji from "@dicebear/fun-emoji";
import * as thumbs from "@dicebear/thumbs";

import { DEFAULT_AVATAR_STYLE, parseAvatar, type Avatar } from "./protocol";

const renderers = {
  avataaars: (seed: string) => createAvatar(avataaars, { seed }),
  bottts: (seed: string) => createAvatar(bottts, { seed }),
  "fun-emoji": (seed: string) => createAvatar(funEmoji, { seed }),
  thumbs: (seed: string) => createAvatar(thumbs, { seed }),
};

export function resolveAvatar(avatar: Avatar | undefined, memberId: string): Avatar {
  return parseAvatar(avatar) ?? { style: DEFAULT_AVATAR_STYLE, seed: memberId };
}

export function avatarImage({ style, seed }: Avatar): string {
  return renderers[style](seed).toDataUri();
}
