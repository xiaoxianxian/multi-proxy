export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private readonly defaultCapacity: number;
  private readonly refillRate: number;

  constructor(options: { capacity?: number; refillRate?: number } = {}) {
    this.defaultCapacity = options.capacity || 60; // 每分钟 60 次
    this.refillRate = options.refillRate || 1; // 每秒补充 1 个 token
  }

  private getBucket(key: string): { tokens: number; lastRefill: number } {
    const now = Date.now();
    if (!this.buckets.has(key)) {
      this.buckets.set(key, { tokens: this.defaultCapacity, lastRefill: now });
    }
    const bucket = this.buckets.get(key)!;
    // 补充令牌
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.defaultCapacity, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;
    return bucket;
  }

  allowRequest(key: string): boolean {
    const bucket = this.getBucket(key);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }
}
