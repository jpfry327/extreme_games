/**
 * ServerClock — the tick↔wall-clock estimator behind tick-timeline
 * interpolation. The property that matters: TCP stall-then-burst delivery
 * (packets late, never early) must not move the clock, while genuine path /
 * skew changes age in smoothly and strictly monotonically.
 */

import { describe, expect, it } from "vitest";
import { ServerClock, type TickClockConfig } from "./tickClock";

const CFG: TickClockConfig = {
  windowMs: 3000,
  bucketMs: 500,
  slewMaxMsPerSec: 20,
  snapThresholdMs: 250,
};

const TICK_MS = 10;

/** Feed a regular ~33Hz stream: tick t arrives at t*10 + transit. */
function feedRegular(
  clock: ServerClock,
  fromTick: number,
  toTick: number,
  transitMs: number,
): void {
  for (let tick = fromTick; tick <= toTick; tick += 3) {
    clock.observe(tick, tick * TICK_MS + transitMs);
  }
}

describe("ServerClock", () => {
  it("returns null before the first observe", () => {
    const clock = new ServerClock(CFG, TICK_MS);
    expect(clock.rawOffsetMs).toBeNull();
    expect(clock.serverTimeMs(1000)).toBeNull();
  });

  it("locks the raw offset to the fastest delivery", () => {
    const clock = new ServerClock(CFG, TICK_MS);
    feedRegular(clock, 0, 90, 40);
    expect(clock.rawOffsetMs).toBe(40);
    // Server time ≈ now − offset.
    const now = 90 * TICK_MS + 45;
    expect(clock.serverTimeMs(now)).toBeCloseTo(now - 40, 5);
  });

  it("ignores a stall-then-burst completely (late packets can't move a min)", () => {
    const clock = new ServerClock(CFG, TICK_MS);
    feedRegular(clock, 0, 90, 40);
    // 300ms stall: ticks 93..120 all delivered together at the window end.
    const burstAt = 120 * TICK_MS + 40 + 300;
    for (let tick = 93; tick <= 120; tick += 3) clock.observe(tick, burstAt);
    expect(clock.rawOffsetMs).toBe(40);
    // The oldest burst packet is the latest vs the timeline; the newest is
    // only 300ms late.
    expect(clock.lastLatenessMs).toBeCloseTo(300, 5);
  });

  it("reports zero lateness for fastest-path deliveries", () => {
    const clock = new ServerClock(CFG, TICK_MS);
    feedRegular(clock, 0, 30, 40);
    expect(clock.lastLatenessMs).toBe(0);
  });

  it("ages a stale fast path out of the window", () => {
    const clock = new ServerClock(CFG, TICK_MS);
    feedRegular(clock, 0, 30, 40); // fast path up to t=340
    // The route degrades: everything is now +100ms, for longer than windowMs.
    feedRegular(clock, 33, 400, 140); // t up to 4140 — 40-offset buckets expire
    expect(clock.rawOffsetMs).toBe(140);
  });

  it("keeps server time strictly monotonic while the offset slews (both directions)", () => {
    const clock = new ServerClock(CFG, TICK_MS);
    feedRegular(clock, 0, 90, 40);

    const sample = (fromMs: number, toMs: number): number[] => {
      const out: number[] = [];
      for (let now = fromMs; now <= toMs; now += 16) {
        const st = clock.serverTimeMs(now);
        if (st !== null) out.push(st);
      }
      return out;
    };

    // Offset steps UP (path got slower and the fast min aged out): raw jumps
    // 40 → 140 while we keep sampling.
    feedRegular(clock, 93, 400, 140);
    const up = sample(4200, 5200);
    for (let i = 1; i < up.length; i++) {
      const slope = (up[i] - up[i - 1]) / 16;
      expect(up[i]).toBeGreaterThan(up[i - 1]);
      expect(slope).toBeGreaterThanOrEqual(1 - CFG.slewMaxMsPerSec / 1000 - 1e-9);
      expect(slope).toBeLessThanOrEqual(1 + CFG.slewMaxMsPerSec / 1000 + 1e-9);
    }

    // Offset steps DOWN (a faster packet arrives): raw drops 140 → 90.
    clock.observe(520, 520 * TICK_MS + 90);
    const down = sample(5300, 6300);
    for (let i = 1; i < down.length; i++) {
      expect(down[i]).toBeGreaterThan(down[i - 1]);
    }
  });

  it("snaps when raw and applied offsets diverge past the threshold", () => {
    const clock = new ServerClock(CFG, TICK_MS);
    feedRegular(clock, 0, 90, 40);
    expect(clock.serverTimeMs(1000)).toBeCloseTo(960, 5);
    // Tab-return pathology: every offset in the window is now +400ms.
    feedRegular(clock, 93, 400, 440);
    // Gap (400) > snapThreshold (250) → applied offset snaps to 440 at once.
    const now = 4100;
    expect(clock.serverTimeMs(now)).toBeCloseTo(now - 440, 5);
  });
});
