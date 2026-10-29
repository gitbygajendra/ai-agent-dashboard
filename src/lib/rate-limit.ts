/**
 * Fixed-window in-memory rate limiter for cheap endpoints (sign-in, CRM
 * writes). It is per server instance; agent runs are additionally limited
 * with a database count in the execution service, which holds across
 * instances. For multi-instance production, swap this for a shared store
 * (e.g. Redis/Upstash) behind the same function signature.
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export type RateLimitResult = { ok: boolean; remaining: number; retryAfterSec: number };

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  if (buckets.size > 10000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  const ok = bucket.count <= limit;
  return {
    ok,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSec: ok ? 0 : Math.ceil((bucket.resetAt - now) / 1000),
  };
}

export function resetRateLimits() {
  buckets.clear();
}
