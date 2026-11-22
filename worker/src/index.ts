import { generateRoomCode, normalizeRoomCode } from "./protocol";

export { Room } from "./room";
export { IpLimiter } from "./ip-limiter";

/**
 * Thin edge router. It holds no state: it validates the URL and hands the
 * request to the one Durable Object that owns that room.
 *
 *   GET  /health               liveness
 *   POST /rooms                create a room -> { code }  (429 past the per-IP limit)
 *   GET  /rooms/:code          does it exist? -> { exists }
 *   GET  /rooms/:code/ws       WebSocket upgrade, handled by the room's DO
 */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/health") return json({ ok: true });

    if (parts[0] !== "rooms") return json({ error: "not found" }, 404);

    // POST /rooms
    if (parts.length === 1) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      // Cloudflare always sets CF-Connecting-IP on real traffic. If it is
      // somehow missing, all such requests share one bucket (fail closed).
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const verdict = await env.IP_LIMITER.get(env.IP_LIMITER.idFromName(ip)).createRoom();
      if (!verdict.ok) {
        const retryAfter = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
        return json({ error: "too many rooms created; try again later", retryAfter }, 429, {
          "retry-after": String(retryAfter),
        });
      }
      // The code is minted here, never by the client, so every code in
      // existence is unguessable (50 bits of crypto-random).
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = generateRoomCode();
        const created = await env.ROOMS.get(env.ROOMS.idFromName(code)).init();
        if (created) return json({ code }, 201);
      }
      return json({ error: "could not allocate a room" }, 503);
    }

    const code = normalizeRoomCode(parts[1] ?? "");
    if (code === null) return json({ error: "invalid room code" }, 400);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));

    // GET /rooms/:code
    if (parts.length === 2) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ exists: await stub.exists() });
    }

    // GET /rooms/:code/ws
    if (parts.length === 3 && parts[2] === "ws") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return stub.fetch(request);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
