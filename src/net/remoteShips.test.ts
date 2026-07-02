import { describe, expect, it } from "vitest";
import { TILE_SIZE, WARBIRD } from "../config";
import { GameMap } from "../sim/gamemap";
import { createPlayer } from "../sim/player";
import type { Player } from "../sim/types";
import { RemoteShipExtrapolator, extrapolatePose, type RemoteShipsConfig } from "./remoteShips";

const CFG: RemoteShipsConfig = { mode: "extrapolate", maxLeadMs: 250, correctionHalfLifeMs: 80 };
const LOCAL = "me";

/** An empty 64×64-tile map (no walls). */
function openMap(): GameMap {
  return new GameMap(64, 64, new Uint8Array(64 * 64));
}

/** A 64×64 map with a solid column of tiles at tile-x 10 (world x 160..176). */
function walledMap(): GameMap {
  const tiles = new Uint8Array(64 * 64);
  for (let ty = 0; ty < 64; ty++) tiles[ty * 64 + 10] = 1;
  return new GameMap(64, 64, tiles);
}

function mover(id: string, x: number, y: number, vx: number, vy = 0): Player {
  const p = createPlayer(id, id, 0, WARBIRD, x, y);
  p.kinematics.vx = vx;
  p.kinematics.vy = vy;
  return p;
}

// NOTE: fixtures start at (100, 100) — the map border counts as solid, so a
// ship near (0,0) would wall-bounce (radius 14) and cloud the assertions.
describe("extrapolatePose", () => {
  it("advances at constant velocity with a sub-tick fraction", () => {
    // 55ms lead = 5.5 ticks at 2 px/tick.
    const pose = extrapolatePose(mover("r", 100, 100, 2), 100, 1055, 250, openMap());
    expect(pose.x).toBeCloseTo(111);
    expect(pose.y).toBeCloseTo(100);
  });

  it("clamps the lead to maxLeadMs (freeze at the cap)", () => {
    // 1000ms since the base but a 250ms cap → 25 ticks, not 100.
    const pose = extrapolatePose(mover("r", 100, 100, 2), 100, 2000, 250, openMap());
    expect(pose.x).toBeCloseTo(150);
  });

  it("never rewinds for a target before the base", () => {
    const pose = extrapolatePose(mover("r", 130, 100, 2), 100, 900, 250, openMap());
    expect(pose.x).toBeCloseTo(130);
  });

  it("bounces off walls like a ship (shared moveAndCollide treatment)", () => {
    // Warbird (radius 14) coasting +x at 3 px/tick from x=140 toward the solid
    // column at world x=160: naive extrapolation over 10 ticks would bury it in
    // the wall at x=170; the shared collision snaps it flush (160−14) and
    // reflects the velocity by the ship's bounceFactor.
    const wallFace = 10 * TILE_SIZE - 14; // 146: flush position for radius 14
    const pose = extrapolatePose(mover("r", 140, 100, 3), 100, 1100, 250, walledMap());
    expect(pose.x).toBeLessThanOrEqual(wallFace);
    expect(pose.vx).toBeLessThan(0); // reflected, retention < 1
    expect(Math.abs(pose.vx)).toBeLessThan(3);
  });
});

describe("RemoteShipExtrapolator", () => {
  it("skips the local player and prunes state for ships gone from the snapshot", () => {
    const ex = new RemoteShipExtrapolator(CFG);
    const map = openMap();
    let out = ex.build([mover(LOCAL, 0, 0, 1), mover("r", 0, 0, 1)], 100, 1000, 1000, LOCAL, map);
    expect(out.map((p) => p.id)).toEqual(["r"]);

    // "r" leaves (AOI exit); its state must drop so a later re-entry far away
    // pops in cleanly instead of absorbing a bogus map-spanning correction.
    ex.build([mover(LOCAL, 0, 0, 1)], 110, 1100, 1100, LOCAL, map);
    out = ex.build([mover("r", 800, 800, 0)], 120, 1200, 1200, LOCAL, map);
    expect(out[0].kinematics.x).toBe(800); // no offset, no smear
  });

  it("keeps the drawn pose continuous when a new snapshot arrives (absorb)", () => {
    const ex = new RemoteShipExtrapolator(CFG);
    const map = openMap();
    // Base tick 100 at (100,100), 2 px/tick → drawn at x=120 at serverNow 1100.
    const first = ex.build([mover("r", 100, 100, 2)], 100, 1100, 1100, LOCAL, map);
    expect(first[0].kinematics.x).toBeCloseTo(120);

    // New base: the ship actually slowed (x=114, 1 px/tick at tick 110). At the
    // same instant (no decay yet) the drawn pose must not jump: the 6px
    // misprediction is absorbed into the offset.
    const second = ex.build([mover("r", 114, 100, 1)], 110, 1100, 1100, LOCAL, map);
    expect(second[0].kinematics.x).toBeCloseTo(120);
  });

  it("decays the correction offset toward the authoritative path", () => {
    const ex = new RemoteShipExtrapolator(CFG);
    const map = openMap();
    ex.build([mover("r", 100, 100, 2)], 100, 1100, 1100, LOCAL, map); // drawn x=120
    ex.build([mover("r", 114, 100, 1)], 110, 1100, 1100, LOCAL, map); // offset +6

    // One half-life (80ms) later: authoritative pose x = 114 + 8×1 = 122,
    // offset decayed 6 → 3, drawn ≈ 125.
    const out = ex.build([mover("r", 114, 100, 1)], 110, 1180, 1180, LOCAL, map);
    expect(out[0].kinematics.x).toBeCloseTo(125, 1);
  });

  it("snaps (no slide) on a teleport-class correction", () => {
    const ex = new RemoteShipExtrapolator(CFG);
    const map = openMap();
    ex.build([mover("r", 100, 100, 0)], 100, 1000, 1000, LOCAL, map);
    // Warp across the map — far past NET.maxSmoothDistancePx (128).
    const out = ex.build([mover("r", 700, 700, 0)], 110, 1100, 1100, LOCAL, map);
    expect(out[0].kinematics.x).toBe(700); // offset dropped, drawn at truth
  });

  it("pins dead ships to the snapshot pose and pops respawns cleanly", () => {
    const ex = new RemoteShipExtrapolator(CFG);
    const map = openMap();
    const dead = mover("r", 50, 50, 2);
    dead.combat.respawnAt = 9999;
    // Dead: no extrapolation despite carried velocity.
    const out1 = ex.build([dead], 100, 1100, 1100, LOCAL, map);
    expect(out1[0].kinematics.x).toBe(50);

    // Respawn at a fresh spawn: no correction absorbed across the death (the
    // old base is the death site) — the ship pops at the spawn, no smear.
    const spawned = mover("r", 900, 900, 0);
    const out2 = ex.build([spawned], 110, 1100, 1100, LOCAL, map);
    expect(out2[0].kinematics.x).toBe(900);
    expect(out2[0].kinematics.y).toBe(900);
  });
});
