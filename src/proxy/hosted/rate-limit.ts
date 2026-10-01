/**
 * Requests per minute per token, separate from spend: a spend cap alone does
 * not stop someone hammering the service with calls cheap enough to fit it.
 *
 * Sliding window over the last 60s. In memory on purpose -- a restart forgets
 * at most one minute of request history, which is not a spend control and
 * needs no durability. One process only (see docs/HOSTED.md).
 */
const WINDOW_MS = 60_000;

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  check(key: string, perMinute: number): RateDecision {
    const now = this.clock();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - WINDOW_MS);
    if (recent.length >= perMinute) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true };
  }

  /** Drop windows with nothing recent in them, so idle tokens cost no memory. */
  sweep(): void {
    const cutoff = this.clock() - WINDOW_MS;
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= cutoff)) this.hits.delete(key);
    }
  }
}
