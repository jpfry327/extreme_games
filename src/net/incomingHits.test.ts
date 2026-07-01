/**
 * Incoming-hit feedback audit — the defender-side mirror of predictedHits.
 * Guards: fires exactly once per projectile, respects death, prunes retired ids.
 */

import { describe, expect, it } from "vitest";
import { WARBIRD } from "../config";
import { createPlayer } from "../sim/player";
import type { Player, Projectile } from "../sim/types";
import { IncomingHitDetector } from "./incomingHits";

const ME = "me";
const ENEMY = "enemy";

function me(x: number, y: number): Player {
  return createPlayer(ME, ME, 0, WARBIRD, x, y);
}

function shot(id: number, x: number, y: number): Projectile {
  return {
    id,
    kind: "bullet",
    owner: ENEMY,
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
  };
}

describe("IncomingHitDetector", () => {
  it("fires once when an enemy shot overlaps the local ship, then never again", () => {
    const d = new IncomingHitDetector();
    const ship = me(100, 100);

    // Far away: no hit.
    expect(d.detect([shot(1, 500, 500)], ship)).toHaveLength(0);

    // Overlapping: exactly one hit, attributed to the shooter.
    const hits = d.detect([shot(1, 101, 100)], ship);
    expect(hits).toHaveLength(1);
    expect(hits[0].by).toBe(ENEMY);
    expect(hits[0].projectileId).toBe(1);
    expect(d.isHit(1)).toBe(true);

    // Still overlapping next frame: no duplicate flash.
    expect(d.detect([shot(1, 100, 100)], ship)).toHaveLength(0);
  });

  it("does not fire on a dead (respawning) local ship", () => {
    const d = new IncomingHitDetector();
    const ship = me(100, 100);
    ship.combat.respawnAt = 9999;
    expect(d.detect([shot(1, 100, 100)], ship)).toHaveLength(0);
  });

  it("does not fire before the local ship exists", () => {
    const d = new IncomingHitDetector();
    expect(d.detect([shot(1, 100, 100)], null)).toHaveLength(0);
  });

  it("prunes retired ids so the seen-set stays bounded and ids can't leak", () => {
    const d = new IncomingHitDetector();
    const ship = me(100, 100);
    d.detect([shot(1, 100, 100)], ship);
    expect(d.isHit(1)).toBe(true);
    // Shot gone from the stream (server removed it) → pruned.
    d.detect([], ship);
    expect(d.isHit(1)).toBe(false);
  });
});
