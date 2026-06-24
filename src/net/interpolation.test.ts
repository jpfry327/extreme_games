import { describe, expect, it } from "vitest";
import { WARBIRD } from "../config";
import { GameMap } from "../sim/gamemap";
import { createPlayer } from "../sim/player";
import type { GameEvent, Player, Projectile } from "../sim/types";
import { World } from "../sim/world";
import { SnapshotInterpolator } from "./interpolation";
import type { Snapshot } from "./snapshot";

// --- fixtures ----------------------------------------------------------------

/** A view world: never stepped, no auto local player (the interpolator fills it). */
function viewWorld(): World {
  return new World(new GameMap(64, 64, new Uint8Array(64 * 64)), 1, false);
}

/** A player at a given pose. createPlayer sets prev*===current; we override the
 *  live pose so a snapshot can carry a distinct position/rotation. */
function playerAt(id: string, x: number, y: number, rotation = 0): Player {
  const p = createPlayer(id, id, 0, WARBIRD, x, y);
  p.kinematics.x = x;
  p.kinematics.y = y;
  p.kinematics.rotation = rotation;
  return p;
}

function projectileAt(id: number, x: number, y: number): Projectile {
  return {
    id,
    kind: "bullet",
    owner: "x",
    x,
    y,
    vx: 0,
    vy: 0,
    life: 50,
    bounces: 0,
    radius: 2,
    alive: true,
    prevX: x,
    prevY: y,
  };
}

function snap(
  tick: number,
  players: Player[],
  projectiles: Projectile[] = [],
  events: GameEvent[] = [],
): Snapshot {
  return { tick, players, projectiles, events, lastProcessedInputSeq: 0, inputBufferDepth: 0 };
}

const LOCAL = "me";

// --- tests -------------------------------------------------------------------

describe("SnapshotInterpolator", () => {
  it("interpolates a remote player halfway between two snapshots", () => {
    const interp = new SnapshotInterpolator();
    // Two snapshots 100ms apart for a remote ship moving (0,0) -> (100,200).
    interp.push(snap(1, [playerAt("r", 0, 0)]), 1000);
    interp.push(snap(2, [playerAt("r", 100, 200)]), 1100);

    const view = viewWorld();
    // interpDelay 100ms; render at now=1150 -> renderTime=1050, exactly halfway.
    interp.buildView(view, 1150, 100, LOCAL);

    const r = view.players.get("r")!;
    expect(r.kinematics.x).toBeCloseTo(50);
    expect(r.kinematics.y).toBeCloseTo(100);
    // prev*===current so the renderer's alpha-lerp is a no-op.
    expect(r.kinematics.prevX).toBe(r.kinematics.x);
    expect(r.kinematics.prevY).toBe(r.kinematics.y);
  });

  it("pins the local player to the newest snapshot (no interpolation)", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(2, [playerAt(LOCAL, 100, 0)]), 1100);

    const view = viewWorld();
    // renderTime would be halfway (1050), but the local ship ignores that and
    // takes the newest snapshot's pose.
    interp.buildView(view, 1150, 100, LOCAL);

    expect(view.players.get(LOCAL)!.kinematics.x).toBe(100);
  });

  it("rotates the short way across the 0/2π seam", () => {
    const interp = new SnapshotInterpolator();
    const twoPi = Math.PI * 2;
    // 0.1 rad before the seam -> 0.1 rad after it. Short path passes through 0,
    // not the long way back through π.
    interp.push(snap(1, [playerAt("r", 0, 0, twoPi - 0.1)]), 1000);
    interp.push(snap(2, [playerAt("r", 0, 0, 0.1)]), 1100);

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL); // t = 0.5

    // Halfway along the short arc sits right at the seam (≡ 0 mod 2π).
    const rot = view.players.get("r")!.kinematics.rotation;
    const norm = ((rot % twoPi) + twoPi) % twoPi;
    expect(Math.min(norm, twoPi - norm)).toBeCloseTo(0);
  });

  it("interpolates projectiles by id and shows brand-new ones at their pose", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt(LOCAL, 0, 0)], [projectileAt(7, 0, 0)]), 1000);
    interp.push(
      snap(2, [playerAt(LOCAL, 0, 0)], [projectileAt(7, 40, 0), projectileAt(8, 99, 99)]),
      1100,
    );

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL); // t = 0.5

    const tracked = view.projectiles.find((p) => p.id === 7)!;
    expect(tracked.x).toBeCloseTo(20); // halfway 0 -> 40
    const fresh = view.projectiles.find((p) => p.id === 8)!;
    expect(fresh.x).toBe(99); // only in newer snapshot -> shown at its pose, no smear
  });

  it("drops a player that left in the newer snapshot", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt(LOCAL, 0, 0), playerAt("gone", 5, 5)]), 1000);
    interp.push(snap(2, [playerAt(LOCAL, 0, 0)]), 1100);

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL);

    expect(view.players.has("gone")).toBe(false);
    expect(view.players.has(LOCAL)).toBe(true);
  });

  it("releases each snapshot's events exactly once, gated by render time", () => {
    const interp = new SnapshotInterpolator();
    const died: GameEvent = {
      type: "shipDied",
      victim: "r",
      killer: LOCAL,
      bounty: 0,
      x: 0,
      y: 0,
    };
    interp.push(snap(1, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(2, [playerAt(LOCAL, 0, 0)], [], [died]), 1100);

    const view = viewWorld();
    // renderTime 1050 (<1100): the event's snapshot hasn't been reached yet.
    interp.buildView(view, 1150, 100, LOCAL);
    expect(view.events).toHaveLength(0);

    // renderTime 1120 (>=1100): event released now...
    interp.buildView(view, 1220, 100, LOCAL);
    expect(view.events).toHaveLength(1);

    // ...and never again.
    interp.buildView(view, 1320, 100, LOCAL);
    expect(view.events).toHaveLength(0);
  });

  it("holds at the newest snapshot when render time runs past the buffer", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt("r", 0, 0)]), 1000);
    interp.push(snap(2, [playerAt("r", 100, 0)]), 1100);

    const view = viewWorld();
    // renderTime 1500 is well past the newest sample (1100) — a lag spike. We
    // hold at newest rather than extrapolating off into space.
    expect(() => interp.buildView(view, 1600, 100, LOCAL)).not.toThrow();
    expect(view.players.get("r")!.kinematics.x).toBe(100);
  });

  it("picks the correct pair among many buffered snapshots", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt("r", 0, 0)]), 1000);
    interp.push(snap(2, [playerAt("r", 100, 0)]), 1100);
    interp.push(snap(3, [playerAt("r", 200, 0)]), 1200);
    interp.push(snap(4, [playerAt("r", 300, 0)]), 1300);

    const view = viewWorld();
    // renderTime = 1250 - 100 = 1150 — halfway through the middle interval,
    // between snapshots 2 (x=100) and 3 (x=200). Exercises the pair-scan loop
    // advancing past index 0.
    interp.buildView(view, 1250, 100, LOCAL);
    expect(view.players.get("r")!.kinematics.x).toBeCloseTo(150);
  });

  it("clamps to the oldest snapshot before the buffer's start", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt("r", 10, 20)]), 1000);
    interp.push(snap(2, [playerAt("r", 100, 200)]), 1100);

    const view = viewWorld();
    // renderTime = 950, before the oldest sample (1000): clamp to the oldest pose.
    interp.buildView(view, 1050, 100, LOCAL);
    const r = view.players.get("r")!;
    expect(r.kinematics.x).toBe(10);
    expect(r.kinematics.y).toBe(20);
  });

  it("shows a newly-joined remote player at its pose without smearing", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(2, [playerAt(LOCAL, 0, 0), playerAt("joiner", 500, 600)]), 1100);

    const view = viewWorld();
    // The joiner is only in the newer snapshot — no older pose to lerp from, so
    // it pops in at its position rather than streaking from the origin.
    interp.buildView(view, 1150, 100, LOCAL);
    const j = view.players.get("joiner")!;
    expect(j.kinematics.x).toBe(500);
    expect(j.kinematics.y).toBe(600);
  });

  it("pins a respawned player to its spawn, not streaking from the death site", () => {
    const interp = new SnapshotInterpolator();
    const dead = playerAt("r", 50, 50);
    dead.combat.respawnAt = 9999; // dead at the death site in the older snapshot
    const spawned = playerAt("r", 900, 900); // alive at a fresh spawn in the newer
    interp.push(snap(1, [playerAt(LOCAL, 0, 0), dead]), 1000);
    interp.push(snap(2, [playerAt(LOCAL, 0, 0), spawned]), 1100);

    const view = viewWorld();
    // t = 0.5 — a naive lerp would put the ship at (475, 475), mid-map. The
    // respawn guard pins it to the fresh spawn instead.
    interp.buildView(view, 1150, 100, LOCAL);
    const r = view.players.get("r")!;
    expect(r.kinematics.x).toBe(900);
    expect(r.kinematics.y).toBe(900);
  });

  it("never mutates buffered snapshot data", () => {
    const interp = new SnapshotInterpolator();
    const older = playerAt("r", 0, 0);
    const newer = playerAt("r", 100, 200);
    interp.push(snap(1, [older]), 1000);
    interp.push(snap(2, [newer]), 1100);

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL); // lerp path (both alive)

    // The view must get fresh copies; the buffered snapshots stay untouched, or
    // the next frame's interpolation would read corrupted `prev*`.
    expect(older.kinematics.x).toBe(0);
    expect(newer.kinematics.x).toBe(100);
    expect(view.players.get("r")!.kinematics).not.toBe(newer.kinematics);
  });
});
