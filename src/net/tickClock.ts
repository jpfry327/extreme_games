/**
 * Server-tick clock estimation — the timebase for tick-timeline interpolation.
 *
 * Maps client `performance.now()` onto the server's sim timeline (`tick × 10ms`)
 * so the client can render "server time T" instead of "whatever arrived N ms
 * ago". The old arrival-time timeline breaks over TCP: a retransmit or a
 * buffering proxy holds the whole snapshot stream and releases it as a burst,
 * so arrival spacing stops reflecting sim spacing — remote ships warp and the
 * lag-comp `renderTick` stamp swings with them.
 *
 * Each snapshot gives one sample `offset = receivedAt − tick·tickMs`, which is
 * `clockSkew + transit`. Transit only ever varies *upward* from the fastest
 * path — a stalled burst makes packets late, never early — so a **windowed
 * minimum** of the offset tracks `skew + fastestTransit` and is completely
 * immune to bursts. That min is the raw clock; a slew-limited smoothed copy is
 * what callers actually read, so route changes / skew drift are absorbed at an
 * imperceptible ≤2% time dilation instead of stepping the timeline.
 */

/** Tunables — see `NET.tickClock` in config.ts for the shipped values. */
export interface TickClockConfig {
  /** Horizon (ms) of the windowed min. Long enough to always contain a few
   *  fast deliveries; short enough that a genuinely slower path ages in. */
  windowMs: number;
  /** Rotating min-bucket width (ms). windowMs/bucketMs buckets give an O(1)
   *  sliding min with at most one bucket of horizon slop. */
  bucketMs: number;
  /** Max rate (ms per second) the applied offset may slew toward the raw min.
   *  Bounds the derivative of estimated server time to 1 ± slew/1000 — small
   *  enough to be invisible, and it keeps the estimate strictly monotonic. */
  slewMaxMsPerSec: number;
  /** A raw-vs-smoothed gap beyond this (ms) is not drift — it's a reconnect or
   *  a tab coming back from the background. Snap instead of slewing for ages. */
  snapThresholdMs: number;
}

interface MinBucket {
  /** Which `floor(receivedAt / bucketMs)` slot this bucket currently holds. */
  slot: number;
  min: number;
}

export class ServerClock {
  private readonly buckets: MinBucket[];
  private newestSlot = -1;
  private smoothed: number | null = null;
  private lastEvalMs = -1;
  private latenessMs = 0;

  constructor(
    private readonly cfg: TickClockConfig,
    private readonly tickMs: number,
  ) {
    const n = Math.max(1, Math.ceil(cfg.windowMs / cfg.bucketMs));
    this.buckets = Array.from({ length: n }, () => ({ slot: -1, min: Infinity }));
  }

  /** Feed every accepted snapshot (main.ts already drops stale ticks, so ticks
   *  arrive monotonically). `receivedAtMs` is `performance.now()` at receipt. */
  observe(tick: number, receivedAtMs: number): void {
    const offset = receivedAtMs - tick * this.tickMs;
    const slot = Math.floor(receivedAtMs / this.cfg.bucketMs);
    const bucket = this.buckets[slot % this.buckets.length];
    if (bucket.slot !== slot) {
      // The bucket's previous contents are a full window old — recycle it.
      bucket.slot = slot;
      bucket.min = offset;
    } else {
      bucket.min = Math.min(bucket.min, offset);
    }
    this.newestSlot = Math.max(this.newestSlot, slot);
    // Seed the applied offset directly on the very first sample; render is
    // clamped to the oldest buffered snapshot during warmup anyway, and the
    // windowed min pulls an initially pessimistic seed down within a window.
    if (this.smoothed === null) this.smoothed = offset;
    const raw = this.rawOffsetMs;
    this.latenessMs = raw === null ? 0 : Math.max(0, offset - raw);
  }

  /** Raw windowed-min offset (ms), or null before the first observe. Exposed
   *  for the debug overlay. */
  get rawOffsetMs(): number | null {
    if (this.newestSlot < 0) return null;
    let min = Infinity;
    for (const b of this.buckets) {
      // Only slots still inside the window relative to the newest count.
      if (b.slot > this.newestSlot - this.buckets.length) min = Math.min(min, b.min);
    }
    return min === Infinity ? null : min;
  }

  /** How late (ms ≥ 0) the most recent snapshot arrived versus the fastest-path
   *  timeline — the burst/stall signal that replaces inter-arrival jitter. */
  get lastLatenessMs(): number {
    return this.latenessMs;
  }

  /**
   * Estimated server sim time (ms on the `tick × tickMs` timeline) at client
   * time `nowMs`. Strictly monotonic across calls with increasing `nowMs`
   * (slew-bounded), except when the snap threshold fires (reconnect /
   * tab-return), where one discontinuity is the correct behavior. Returns null
   * before the first observe.
   */
  serverTimeMs(nowMs: number): number | null {
    const raw = this.rawOffsetMs;
    if (raw === null || this.smoothed === null) return null;
    const dtMs = this.lastEvalMs < 0 ? 0 : Math.max(0, nowMs - this.lastEvalMs);
    this.lastEvalMs = nowMs;
    const gap = raw - this.smoothed;
    if (Math.abs(gap) > this.cfg.snapThresholdMs) {
      this.smoothed = raw;
    } else {
      const maxStep = (this.cfg.slewMaxMsPerSec * dtMs) / 1000;
      this.smoothed += Math.max(-maxStep, Math.min(maxStep, gap));
    }
    return nowMs - this.smoothed;
  }
}
