import { DurableObject } from "cloudflare:workers";

import { RATE_SCHEMA, takeToken, type Verdict } from "./limiter";

/** Room creation per client IP: 10 rooms per rolling hour. */
export const ROOM_CREATE_LIMIT = { max: 10, windowMs: 60 * 60 * 1000 } as const;

/**
 * One tiny Durable Object per client IP (`idFromName(ip)`), so the count is a
 * single strongly consistent counter worldwide. It stores only timestamps and
 * wipes itself once the window has passed with no new hits.
 */
export class IpLimiter extends DurableObject<Env> {
  async createRoom(): Promise<Verdict> {
    const { max, windowMs } = ROOM_CREATE_LIMIT;
    // Here, not in the constructor: alarm() wipes storage while the object may stay in memory.
    this.ctx.storage.sql.exec(RATE_SCHEMA);
    const verdict = takeToken(this.ctx.storage.sql, "create", max, windowMs);
    if (verdict.ok) await this.ctx.storage.setAlarm(Date.now() + windowMs);
    return verdict;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
