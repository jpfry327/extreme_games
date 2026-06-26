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
  it("reports an overlap of a predicted shot with an enemy", () => {
    const d = new PredictedHitDetector();
    const enemy = enemyAt(100, 100);
    const hits = d.detect([proj(100, 100, { spawnSeq: 5, kind: "bomb" })], [enemy]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "bomb", target: "e1", seq: 5, x: 100, y: 100 });
  });

  it("does not report a shot that misses", () => {
    const d = new PredictedHitDetector();
    const enemy = enemyAt(100, 100); // radius 14 + bullet radius 2 = 18px reach
    expect(d.detect([proj(200, 200)], [enemy])).toHaveLength(0);
  });

  it("ignores already-acked shots (no spawnSeq)", () => {
    const d = new PredictedHitDetector();
    const enemy = enemyAt(100, 100);
    expect(d.detect([proj(100, 100, { spawnSeq: undefined })], [enemy])).toHaveLength(0);
  });

  it("ignores dead/respawning enemies", () => {
    const d = new PredictedHitDetector();
    const ghost = enemyAt(100, 100);
    ghost.combat.respawnAt = 999; // not alive
    expect(d.detect([proj(100, 100)], [ghost])).toHaveLength(0);
  });

  it("detonates a given shot only once", () => {
    const d = new PredictedHitDetector();
    const enemy = enemyAt(100, 100);
    const shot = proj(100, 100, { spawnSeq: 7 });
    expect(d.detect([shot], [enemy])).toHaveLength(1);
    expect(d.isHit(7)).toBe(true);
    // Same shot still overlapping next frame — not reported again.
    expect(d.detect([shot], [enemy])).toHaveLength(0);
  });

  it("prunes hit seqs at/below the server ack so the set can't grow unbounded", () => {
    const d = new PredictedHitDetector();
    const enemy = enemyAt(100, 100);
    d.detect([proj(100, 100, { spawnSeq: 3 })], [enemy]);
    expect(d.isHit(3)).toBe(true);
    d.prune(3); // server has acked seq 3
    expect(d.isHit(3)).toBe(false);
  });
});
