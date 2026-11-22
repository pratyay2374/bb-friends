// Bindings declared in wrangler.jsonc. `Env` is what the Worker and the Room
// receive; `Cloudflare.Env` is what `cloudflare:test` hands to tests.
interface Env {
  ROOMS: DurableObjectNamespace<import("./room").Room>;
  IP_LIMITER: DurableObjectNamespace<import("./ip-limiter").IpLimiter>;
}
declare namespace Cloudflare {
  interface Env {
    ROOMS: DurableObjectNamespace<import("./room").Room>;
    IP_LIMITER: DurableObjectNamespace<import("./ip-limiter").IpLimiter>;
  }
}
