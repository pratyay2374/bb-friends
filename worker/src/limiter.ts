/**
 * Durable sliding-window rate limiter over a Durable Object's SQLite storage.
 * Shared by the Room (per-sender limits) and the IpLimiter (room creation).
 *
 * The caller's schema must contain:
 *   CREATE TABLE rate (key TEXT NOT NULL, at INTEGER NOT NULL);
 */
export const RATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS rate (key TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS rate_key ON rate (key, at);
`;

export type Verdict = { ok: true } | { ok: false; retryAfterMs: number };

/** Records a hit for `key` if fewer than `max` hits landed in the last `windowMs`. */
export function takeToken(
  sql: SqlStorage,
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): Verdict {
  sql.exec("DELETE FROM rate WHERE key = ? AND at <= ?", key, now - windowMs);
  const { n, oldest } = sql
    .exec<{ n: number; oldest: number | null }>(
      "SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate WHERE key = ?",
      key,
    )
    .one();
  if (n >= max) {
    // The window frees a slot when its oldest hit ages out.
    return { ok: false, retryAfterMs: Math.max(0, (oldest ?? now) + windowMs - now) };
  }
  sql.exec("INSERT INTO rate (key, at) VALUES (?, ?)", key, now);
  return { ok: true };
}
