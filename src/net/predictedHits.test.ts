import { describe, expect, it } from "vitest";
import { WARBIRD } from "../config";
import { createPlayer } from "../sim/player";
import type { Player, Projectile } from "../sim/types";
import { PredictedHitDetector } from "./predictedHits";

/** A predicted bullet at (x,y). `spawnSeq` present = an un-acked predicted shot. */
function proj(x: number, y: number, over: Partial<Projectile> = {}): Projectile {
  return {
    id: -1,
    kind: "bullet",
    owner: "me",
    x,
    y,
    vx: 0,
    vy: 0,
    life: 100,
    bounces: 0,
    radius: 2,
    alive: true,
    prevX: x,
    prevY: y,
    spawnSeq: 1,
    ...over,
  };
}

function enemyAt(x: number, y: number): Player {
  return createPlayer("e1", "Foe", 1, WARBIRD, x, y);
}

describe("PredictedHitDetector", () => {
  it("reports an overlap of an un-acked predicted shot with an enemy", () => {
    const d = new PredictedHitDetector();
    const enemy = enemyAt(100, 100);
    const hits = d.detect([proj(100, 100, { id: -11, spawnSeq: 5, kind: "bomb" })], [enemy]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "bomb", target: "e1", projectileId: -11, spawnSeq: 5, x: 100, y: 100 });
  });

  it("does not report a shot that misses", () => {
    const d = new PredictedHitDetector();
    const enemy = enemyAt(100, 100); // radius 14 + bullet radius 2 = 18px reach
    expect(d.detect([proj(200, 200)], [enemy])).toHaveLength(0);
  });

  it("reports an acked in-flight shot (no spawnSeq) — it's still a sprite on screen", () => {
    const d = new PredictedHitDetector();
    const enemy = enemyAt(100, 100);
    // Acked shots carry a stable positive server id and no spawnSeq; they're drawn
    // at the leading edge just like un-acked ones, so they must still register.
    const hits = d.detect([proj(100, 100, { id: 42, spawnSeq: undefined })], [enemy]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ projectileId: 42, target: "e1" });
    expect(hits[0].spawnSeq).toBeUndefined(); // tells the caller to suppress by id
  });

  it("ignores dead/respawning enemies", () => {
    const d = new PredictedHitDetector();
    const ghost = enemyAt(100, 100);
    ghost.combat.respawnAt = 999; // not alive
    expect(d.detect([proj(100, 100)], [ghost])).toHaveLength(0);
  });

  it("detonates a given shot only once, keyed by projectile id", () => {
    const d = new PredictedHitDetector();
    const enemy = enemyAt(100, 100);
    const shot = proj(100, 100, { id: 7, spawnSeq: undefined });
    expect(d.detect([shot], [enemy])).toHaveLength(1);
    expect(d.isHit(7)).toBe(true);
    // Same shot still overlapping next frame — not reported again.
    expect(d.detect([shot], [enemy])).toHaveLength(0);
  });

  it("prunes a hit id once the shot is no longer in flight, bounding the set", () => {
    const d = new PredictedHitDetector();
    const enemy = enemyAt(100, 100);
    d.detect([proj(100, 100, { id: 3, spawnSeq: undefined })], [enemy]);
    expect(d.isHit(3)).toBe(true);
    // Next frame the server has removed the shot (it's gone from the list).
    d.detect([], [enemy]);
    expect(d.isHit(3)).toBe(false);
  });
});
