/** Simple per-key token bucket used to rate-limit the local HTTP API. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: t };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((t - bucket.updated) / 1000) * this.refillPerSecond);
    bucket.updated = t;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 1000) {
      // Avoid unbounded growth from many distinct clients.
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) {
        this.buckets.delete(oldest);
      }
    }
    return true;
  }
}
