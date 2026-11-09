// A token bucket for each client address. Buckets refill over time, so a short
// burst from panning the map is fine but sustained scraping is refused.
const MAX_TRACKED_CLIENTS = 50_000;

export function createRateLimiter({
  perSecond = 5,
  burst = 60,
  now = () => performance.now(),
} = {}) {
  const buckets = new Map();

  function forget(time) {
    // A bucket that would be full again carries no information.
    for (const [address, bucket] of buckets)
      if (bucket.tokens + ((time - bucket.seen) / 1000) * perSecond >= burst)
        buckets.delete(address);
    // A flood of distinct addresses must not grow memory without limit.
    for (const address of buckets.keys()) {
      if (buckets.size < MAX_TRACKED_CLIENTS) break;
      buckets.delete(address);
    }
  }

  return {
    // Returns 0 when allowed, otherwise the seconds until a retry can succeed.
    check(address) {
      const time = now();
      if (buckets.size >= MAX_TRACKED_CLIENTS) forget(time);
      const bucket = buckets.get(address) ?? { tokens: burst, seen: time };
      bucket.tokens = Math.min(
        burst,
        bucket.tokens + ((time - bucket.seen) / 1000) * perSecond,
      );
      bucket.seen = time;
      buckets.set(address, bucket);
      if (bucket.tokens < 1)
        return Math.max(1, Math.ceil((1 - bucket.tokens) / perSecond));
      bucket.tokens -= 1;
      return 0;
    },
    get size() {
      return buckets.size;
    },
  };
}

// Each trusted proxy appends the address it saw, so the entries on the left
// can be forged by the client. Only the one added by our own proxy counts.
export function clientAddress(req, trustedProxies = 0) {
  const forwarded = req.headers["x-forwarded-for"];
  if (trustedProxies > 0 && typeof forwarded === "string") {
    const hops = forwarded.split(",").map((part) => part.trim());
    const address = hops[hops.length - trustedProxies];
    if (address) return address;
  }
  return req.socket.remoteAddress ?? "unknown";
}
