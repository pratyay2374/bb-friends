import { runDurableObjectAlarm, runInDurableObject, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ROOM_CREATE_LIMIT } from "../src/ip-limiter";
import { postRoom, randomIp } from "./helpers";

const { max } = ROOM_CREATE_LIMIT;

async function burst(ip: string | null, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await postRoom(ip)).status);
  return statuses;
}

describe("per-IP room creation limit", () => {
  it(`allows ${max} rooms per IP`, async () => {
    expect(await burst(randomIp(), max)).toEqual(Array(max).fill(201));
  });

  it("returns 429 with Retry-After past the limit, and mints no room", async () => {
    const ip = randomIp();
    await burst(ip, max);
    const res = await postRoom(ip);
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(ROOM_CREATE_LIMIT.windowMs / 1000);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBeUndefined();
    expect(body.error).toMatch(/too many/);
  });

  it("keeps IPs isolated: one IP's limit doesn't affect another", async () => {
    const noisy = randomIp();
    await burst(noisy, max);
    expect((await postRoom(noisy)).status).toBe(429);
    expect((await postRoom(randomIp())).status).toBe(201);
    expect((await postRoom(noisy)).status).toBe(429);
  });

  it("puts requests without CF-Connecting-IP in one shared bucket (fail closed)", async () => {
    expect(await burst(null, max)).toEqual(Array(max).fill(201));
    expect((await postRoom(null)).status).toBe(429);
  });

  it("frees slots as the window slides, and the alarm wipes idle limiters", async () => {
    const ip = randomIp();
    await burst(ip, max);
    const stub = env.IP_LIMITER.get(env.IP_LIMITER.idFromName(ip));
    // Age every recorded hit past the window.
    await runInDurableObject(stub, (_obj, state) => {
      state.storage.sql.exec("UPDATE rate SET at = at - ?", ROOM_CREATE_LIMIT.windowMs + 1);
    });
    expect((await postRoom(ip)).status).toBe(201);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_obj, state) => {
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'rate'").toArray()).toEqual([]);
    });
    // Still works after the wipe.
    expect((await postRoom(ip)).status).toBe(201);
  });
});
