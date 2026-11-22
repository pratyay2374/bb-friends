import { generateRoomCode, normalizeRoomCode } from "./protocol";

export { Room } from "./room";

/**
 * Thin edge router. It holds no state: it validates the URL and hands the
 * request to the one Durable Object that owns that room.
 *
 *   GET  /health               liveness
 *   POST /rooms                create a room -> { code }
 *   GET  /rooms/:code          does it exist? -> { exists }
 *   GET  /rooms/:code/ws       WebSocket upgrade, handled by the room's DO
 */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
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
