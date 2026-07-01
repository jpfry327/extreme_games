/**
 * Remote-projectile simulation audit — M2.8, updated for present-time rendering.
 *
 * Remote shots are simulated forward deterministically from the **newest**
 * snapshot to the estimated server present (the same determinism the local ship
 * (M2.4) and own shots (M2.6) rely on, turned outward). These tests guard:
 *
 *   1. A remote bullet simulated locally through a **wall bounce** reproduces the
 *      server's path bit-for-bit — this is what removes the bounce "teleport".
 *   2. A bullet the **server killed** is absent from the newest snapshot and so
 *      simply stops being rendered — retraction is implicit in the base choice.
 *   3. The forward window is clamped to `maxLeadMs`, so a stall freezes shots at
 *      the cap instead of flying them unboundedly on stale state.
 *
 * Mirrors `net/determinism.test.ts`: the simulator is held to the *same*
 * `projectileSystem` the server runs, so equality is exact, not approximate.
 */

import { describe, expect, it } from "vitest";
import { TICK_DT } from "../config";
import { GameMap } from "../sim/gamemap";
import { projectileSystem } from "../sim/systems/projectiles";
import type { Projectile } from "../sim/types";
import { World } from "../sim/world";
import { RemoteProjectileSimulator } from "./remoteProjectiles";
import type { Snapshot } from "./snapshot";

const LOCAL = "me";
const REMOTE = "enemy";

const TICK_MS = 1000 * TICK_DT;

/** A 64×64-tile open map with a solid vertical wall one tile wide at tile x=20
 *  (world x 320..336), so a bullet flying +x into it bounces back. */
function wallMap(): GameMap {
  const w = 64;
  const tiles = new Uint8Array(w * w);
  for (let ty = 0; ty < w; ty++) tiles[ty * w + 20] = 1;
  return new GameMap(w, w, tiles);
}

function bullet(partial: Partial<Projectile> & { id: number }): Projectile {
  return {
    kind: "bullet",
    owner: REMOTE,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 200,
    bounces: 5,
    radius: 1,
    alive: true,
    prevX: 0,
    prevY: 0,
    ...partial,
  };
}

/** Minimal snapshot carrying just the projectiles under test. */
function snapshot(tick: number, projectiles: Projectile[]): Snapshot {
  return {
    tick,
    players: [],
    projectiles,
    events: [],
    lastProcessedInputSeq: 0,
    inputBufferDepth: 0,
    pings: {},
  };
}

/** Step a copy of `proj` forward `ticks` whole ticks through the real sim, the
 *  server's ground truth. */
function groundTruth(map: GameMap, proj: Projectile, ticks: number): Projectile {
  const w = new World(map, 1, false);
  w.projectiles = [structuredClone(proj)];
  for (let i = 0; i < ticks; i++) projectileSystem(w);
  return w.projectiles[0];
}

describe("remote-projectile simulation (present-time)", () => {
  it("reproduces a wall-bounce path bit-for-bit, no teleport", () => {
    const map = wallMap();
    // Heading +x straight at the wall at x=320, fast enough to reach and bounce.
    const base = bullet({ id: 1, x: 100, y: 100, vx: 5, vy: 0 });

    const K = 60; // far enough that it has hit the wall and is travelling back
    const sim = new RemoteProjectileSimulator(map);

    const buffer = [{ snap: snapshot(0, [base]), receivedAt: 1000 }];
    // Present = K ticks past the base snapshot → exactly K whole steps (frac 0).
    const out = sim.simulate(buffer, K * TICK_MS, LOCAL, 10_000);
    const truth = groundTruth(map, base, K);

    expect(out).toHaveLength(1);
    const got = out[0];
    // The bounce actually happened (velocity reversed) — the path we'd otherwise
    // have lerped straight through.
    expect(truth.vx).toBeLessThan(0);
    expect(got.vx).toBeLessThan(0);
    // …and the simulated pose equals the server's, exactly.
    expect(got.x).toBe(truth.x);
    expect(got.y).toBe(truth.y);
    expect(got.vx).toBe(truth.vx);
    expect(got.vy).toBe(truth.vy);
    expect(got.bounces).toBe(truth.bounces);
    expect(got.life).toBe(truth.life);
  });

  it("simulates from the NEWEST snapshot — a server-killed bullet stops rendering", () => {
    const map = wallMap();
    const a1 = bullet({ id: 1, x: 50, y: 50, vx: 0, vy: 2 });
    const a2 = bullet({ id: 2, x: 60, y: 50, vx: 0, vy: 2 });

    const sim = new RemoteProjectileSimulator(map);
    const buffer = [
      { snap: snapshot(0, [a1, a2]), receivedAt: 1000 },
      // Newest snapshot: the server killed #2 (a ship hit our map-only sim can't
      // see); #1 carries its authoritative tick-20 pose.
      { snap: snapshot(20, [groundTruth(map, a1, 20)]), receivedAt: 1200 },
    ];
    // Present = tick 30 → 10 whole steps forward from the newest base.
    const out = sim.simulate(buffer, 30 * TICK_MS, LOCAL, 10_000);

    expect(out.map((p) => p.id)).toEqual([1]);
    // Stepping the newest base forward matches stepping the original from tick 0
    // — determinism makes the snapshot hand-off seamless (no pop).
    const truth = groundTruth(map, a1, 30);
    expect(out[0].x).toBe(truth.x);
    expect(out[0].y).toBe(truth.y);
  });

  it("clamps the forward window to maxLeadMs (stall freeze)", () => {
    const map = wallMap();
    const base = bullet({ id: 1, x: 50, y: 50, vx: 2, vy: 0 });
    const sim = new RemoteProjectileSimulator(map);
    const buffer = [{ snap: snapshot(0, [base]), receivedAt: 1000 }];

    // Present says 100 ticks have passed, but the lead cap is 250ms = 25 ticks:
    // the bullet freezes at its 25-tick pose instead of flying on stale state.
    const out = sim.simulate(buffer, 100 * TICK_MS, LOCAL, 250);
    const truth = groundTruth(map, base, 25);
    expect(out[0].x).toBe(truth.x);
  });

  it("excludes the local player's own shots (those come from the Predictor)", () => {
    const map = wallMap();
    const mine = bullet({ id: 7, owner: LOCAL, x: 50, y: 50, vx: 1, vy: 0 });
    const theirs = bullet({ id: 8, owner: REMOTE, x: 80, y: 50, vx: 1, vy: 0 });

    const sim = new RemoteProjectileSimulator(map);
    const buffer = [{ snap: snapshot(0, [mine, theirs]), receivedAt: 1000 }];
    const out = sim.simulate(buffer, 100, LOCAL, 10_000);
    expect(out.map((p) => p.id)).toEqual([8]);
  });

  it("returns nothing before the clock exists (null present time)", () => {
    const map = wallMap();
    const sim = new RemoteProjectileSimulator(map);
    const buffer = [{ snap: snapshot(0, [bullet({ id: 1 })]), receivedAt: 1000 }];
    expect(sim.simulate(buffer, null, LOCAL, 10_000)).toEqual([]);
  });
});
