import { describe, expect, it } from "vitest";
import { WARBIRD } from "../config";
import { GameMap } from "../sim/gamemap";
import { createPlayer } from "../sim/player";
import type { GameEvent, Player, Projectile } from "../sim/types";
import { World } from "../sim/world";
import { SnapshotInterpolator } from "./interpolation";
import type { RemoteShipsConfig } from "./remoteShips";
import type { Snapshot } from "./snapshot";

// M2.17 Phase D: the remote-ship mode is injectable. The long-standing suite
// below pins `"interpolate"` — it IS the regression guard the config flag's
// fallback promises. Extrapolate-mode behavior is tested in its own describe
// (and the extrapolator's internals in remoteShips.test.ts).
const INTERP: RemoteShipsConfig = { mode: "interpolate", maxLeadMs: 250, correctionHalfLifeMs: 80 };
const EXTRAP: RemoteShipsConfig = { mode: "extrapolate", maxLeadMs: 250, correctionHalfLifeMs: 80 };

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
  return { tick, players, projectiles, events, lastProcessedInputSeq: 0, inputBufferDepth: 0, pings: {} };
}

const LOCAL = "me";

// --- tests -------------------------------------------------------------------

describe("SnapshotInterpolator", () => {
  it("interpolates a remote player halfway between two snapshots", () => {
    const interp = new SnapshotInterpolator(INTERP);
    // Two snapshots 100ms apart for a remote ship moving (0,0) -> (100,200).
    interp.push(snap(100, [playerAt("r", 0, 0)]), 1000);
    interp.push(snap(110, [playerAt("r", 100, 200)]), 1100);

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
    const interp = new SnapshotInterpolator(INTERP);
    interp.push(snap(100, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(110, [playerAt(LOCAL, 100, 0)]), 1100);

    const view = viewWorld();
    // renderTime would be halfway (1050), but the local ship ignores that and
    // takes the newest snapshot's pose.
    interp.buildView(view, 1150, 100, LOCAL);

    expect(view.players.get(LOCAL)!.kinematics.x).toBe(100);
  });

  it("rotates the short way across the 0/2π seam", () => {
    const interp = new SnapshotInterpolator(INTERP);
    const twoPi = Math.PI * 2;
    // 0.1 rad before the seam -> 0.1 rad after it. Short path passes through 0,
    // not the long way back through π.
    interp.push(snap(100, [playerAt("r", 0, 0, twoPi - 0.1)]), 1000);
    interp.push(snap(110, [playerAt("r", 0, 0, 0.1)]), 1100);

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL); // t = 0.5

    // Halfway along the short arc sits right at the seam (≡ 0 mod 2π).
    const rot = view.players.get("r")!.kinematics.rotation;
    const norm = ((rot % twoPi) + twoPi) % twoPi;
    expect(Math.min(norm, twoPi - norm)).toBeCloseTo(0);
  });

  it("no longer interpolates projectiles — leaves them for the simulator (M2.8)", () => {
    // M2.8 moved all projectile handling out of buildView: own shots come from
    // the Predictor (M2.6), everyone else's from the RemoteProjectileSimulator
    // (simulated deterministically so bounces don't teleport). buildView must
    // leave view.projectiles empty so those two sources start from a clean list.
    const interp = new SnapshotInterpolator(INTERP);
    interp.push(snap(100, [playerAt(LOCAL, 0, 0)], [projectileAt(7, 0, 0)]), 1000);
    interp.push(
      snap(110, [playerAt(LOCAL, 0, 0)], [projectileAt(7, 40, 0), projectileAt(8, 99, 99)]),
      1100,
    );

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL); // t = 0.5

    expect(view.projectiles).toHaveLength(0);
  });

  it("drops a player that left in the newer snapshot", () => {
    const interp = new SnapshotInterpolator(INTERP);
    interp.push(snap(100, [playerAt(LOCAL, 0, 0), playerAt("gone", 5, 5)]), 1000);
    interp.push(snap(110, [playerAt(LOCAL, 0, 0)]), 1100);

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL);

    expect(view.players.has("gone")).toBe(false);
    expect(view.players.has(LOCAL)).toBe(true);
  });

  it("releases each snapshot's events exactly once, gated by render time", () => {
    const interp = new SnapshotInterpolator(INTERP);
    const died: GameEvent = {
      type: "shipDied",
      victim: "r",
      killer: LOCAL,
      bounty: 0,
      x: 0,
      y: 0,
    };
    interp.push(snap(100, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(110, [playerAt(LOCAL, 0, 0)], [], [died]), 1100);

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

  it("releases bombExploded promptly (present-anchored), other events in render time", () => {
    const interp = new SnapshotInterpolator(INTERP);
    const boom: GameEvent = { type: "bombExploded", x: 0, y: 0, owner: "r" };
    const died: GameEvent = { type: "shipDied", victim: "r", killer: LOCAL, bounty: 0, x: 0, y: 0 };
    interp.push(snap(100, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(110, [playerAt(LOCAL, 0, 0)], [], [boom, died]), 1100);

    const view = viewWorld();
    // renderTime 1050 (<1100): the boom fires now (its bullet is drawn at the
    // present), the ship-anchored death waits for the interpolated timeline.
    interp.buildView(view, 1150, 100, LOCAL);
    expect(view.events.map((e) => e.type)).toEqual(["bombExploded"]);

    // renderTime 1120 (≥1100): the death releases — and the boom doesn't repeat.
    interp.buildView(view, 1220, 100, LOCAL);
    expect(view.events.map((e) => e.type)).toEqual(["shipDied"]);
  });

  it("holds at the newest snapshot when render time runs past the buffer", () => {
    const interp = new SnapshotInterpolator(INTERP);
    interp.push(snap(100, [playerAt("r", 0, 0)]), 1000);
    interp.push(snap(110, [playerAt("r", 100, 0)]), 1100);

    const view = viewWorld();
    // renderTime 1500 is well past the newest sample (1100) — a lag spike. We
    // hold at newest rather than extrapolating off into space.
    expect(() => interp.buildView(view, 1600, 100, LOCAL)).not.toThrow();
    expect(view.players.get("r")!.kinematics.x).toBe(100);
  });

  it("picks the correct pair among many buffered snapshots", () => {
    const interp = new SnapshotInterpolator(INTERP);
    interp.push(snap(100, [playerAt("r", 0, 0)]), 1000);
    interp.push(snap(110, [playerAt("r", 100, 0)]), 1100);
    interp.push(snap(120, [playerAt("r", 200, 0)]), 1200);
    interp.push(snap(130, [playerAt("r", 300, 0)]), 1300);

    const view = viewWorld();
    // renderTime = 1250 - 100 = 1150 — halfway through the middle interval,
    // between snapshots 2 (x=100) and 3 (x=200). Exercises the pair-scan loop
    // advancing past index 0.
    interp.buildView(view, 1250, 100, LOCAL);
    expect(view.players.get("r")!.kinematics.x).toBeCloseTo(150);
  });

  it("clamps to the oldest snapshot before the buffer's start", () => {
    const interp = new SnapshotInterpolator(INTERP);
    interp.push(snap(100, [playerAt("r", 10, 20)]), 1000);
    interp.push(snap(110, [playerAt("r", 100, 200)]), 1100);

    const view = viewWorld();
    // renderTime = 950, before the oldest sample (1000): clamp to the oldest pose.
    interp.buildView(view, 1050, 100, LOCAL);
    const r = view.players.get("r")!;
    expect(r.kinematics.x).toBe(10);
    expect(r.kinematics.y).toBe(20);
  });

  it("shows a newly-joined remote player at its pose without smearing", () => {
    const interp = new SnapshotInterpolator(INTERP);
    interp.push(snap(100, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(110, [playerAt(LOCAL, 0, 0), playerAt("joiner", 500, 600)]), 1100);

    const view = viewWorld();
    // The joiner is only in the newer snapshot — no older pose to lerp from, so
    // it pops in at its position rather than streaking from the origin.
    interp.buildView(view, 1150, 100, LOCAL);
    const j = view.players.get("joiner")!;
    expect(j.kinematics.x).toBe(500);
    expect(j.kinematics.y).toBe(600);
  });

  it("pins a respawned player to its spawn, not streaking from the death site", () => {
    const interp = new SnapshotInterpolator(INTERP);
    const dead = playerAt("r", 50, 50);
    dead.combat.respawnAt = 9999; // dead at the death site in the older snapshot
    const spawned = playerAt("r", 900, 900); // alive at a fresh spawn in the newer
    interp.push(snap(100, [playerAt(LOCAL, 0, 0), dead]), 1000);
    interp.push(snap(110, [playerAt(LOCAL, 0, 0), spawned]), 1100);

    const view = viewWorld();
    // t = 0.5 — a naive lerp would put the ship at (475, 475), mid-map. The
    // respawn guard pins it to the fresh spawn instead.
    interp.buildView(view, 1150, 100, LOCAL);
    const r = view.players.get("r")!;
    expect(r.kinematics.x).toBe(900);
    expect(r.kinematics.y).toBe(900);
  });

  it("never mutates buffered snapshot data", () => {
    const interp = new SnapshotInterpolator(INTERP);
    const older = playerAt("r", 0, 0);
    const newer = playerAt("r", 100, 200);
    interp.push(snap(100, [older]), 1000);
    interp.push(snap(110, [newer]), 1100);

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL); // lerp path (both alive)

    // The view must get fresh copies; the buffered snapshots stay untouched, or
    // the next frame's interpolation would read corrupted `prev*`.
    expect(older.kinematics.x).toBe(0);
    expect(newer.kinematics.x).toBe(100);
    expect(view.players.get("r")!.kinematics).not.toBe(newer.kinematics);
  });

  it("interpolates across a burst of snapshots that arrived at the same instant", () => {
    const interp = new SnapshotInterpolator(INTERP);
    interp.push(snap(100, [playerAt("r", 0, 0)]), 1000);
    // TCP stall: ticks 110 and 120 are held and delivered together at 1400. On
    // the old arrival-time timeline their span was 0ms (interpolation between
    // them was impossible); on the tick timeline they sit at 1100 and 1200
    // regardless of when the wire delivered them.
    interp.push(snap(110, [playerAt("r", 100, 0)]), 1400);
    interp.push(snap(120, [playerAt("r", 200, 0)]), 1400);

    const view = viewWorld();
    interp.buildView(view, 1400, 250, LOCAL); // renderTime = 1150, halfway 110→120
    expect(view.players.get("r")!.kinematics.x).toBeCloseTo(150);
  });

  it("renderTick advances monotonically through stall-then-burst arrival", () => {
    const interp = new SnapshotInterpolator(INTERP);
    // Regular ~33Hz stream with a 40ms transit…
    for (let tick = 100; tick <= 130; tick += 3) {
      interp.push(snap(tick, [playerAt("r", 0, 0)]), tick * 10 + 40);
    }
    // …then a 300ms stall: ticks 133..160 all delivered in one burst. Late
    // packets can't lower the windowed-min clock offset, so the timeline — and
    // with it the lag-comp stamp — must keep advancing smoothly.
    for (let tick = 133; tick <= 160; tick += 3) {
      interp.push(snap(tick, [playerAt("r", 0, 0)]), 1940);
    }
    let prev = -Infinity;
    for (let now = 1400; now <= 2000; now += 16) {
      const rt = interp.renderTick(now, 75, 100);
      expect(rt).not.toBeNull();
      expect(rt!).toBeGreaterThanOrEqual(prev);
      prev = rt!;
    }
    // And it actually advanced (not pinned by the monotonic guard).
    expect(prev).toBeGreaterThan(130);
  });
});

// M2.17 Phase D — remote ships extrapolated to the estimated server present.
// (In these tests receivedAt === tick×10ms exactly, so the tick clock's offset
// is 0 and estimated server time equals the client clock — leads are exact.)
describe("SnapshotInterpolator (extrapolate mode)", () => {
  function moverAt(id: string, x: number, y: number, vx: number, vy = 0): Player {
    const p = playerAt(id, x, y);
    p.kinematics.vx = vx;
    p.kinematics.vy = vy;
    return p;
  }

  // NOTE: fixtures start at (100, 100) — the map border counts as solid, so a
  // ship near (0,0) would wall-bounce (radius 14) and cloud the assertions.
  it("draws a remote ship advanced to the estimated server present", () => {
    const interp = new SnapshotInterpolator(EXTRAP);
    interp.push(snap(100, [moverAt("r", 100, 100, 2)]), 1000);

    const view = viewWorld();
    // serverNow = 1100 → 100ms = 10 ticks past the snapshot at 2 px/tick.
    interp.buildView(view, 1100, 75, LOCAL);
    const k = view.players.get("r")!.kinematics;
    expect(k.x).toBeCloseTo(120);
    expect(k.prevX).toBe(k.x); // baked pose — alpha-lerp is a no-op
  });

  it("advances by the sub-tick fraction for smooth motion", () => {
    const interp = new SnapshotInterpolator(EXTRAP);
    interp.push(snap(100, [moverAt("r", 100, 100, 2)]), 1000);

    const view = viewWorld();
    interp.buildView(view, 1005, 75, LOCAL); // +5ms = 0.5 tick
    expect(view.players.get("r")!.kinematics.x).toBeCloseTo(101);
  });

  it("freezes at the lead cap during a stall instead of gliding unboundedly", () => {
    const interp = new SnapshotInterpolator(EXTRAP);
    interp.push(snap(100, [moverAt("r", 100, 100, 2)]), 1000);

    const view = viewWorld();
    // 500ms since the snapshot, cap 250ms → 25 ticks, not 50.
    interp.buildView(view, 1500, 75, LOCAL);
    expect(view.players.get("r")!.kinematics.x).toBeCloseTo(150);
  });

  it("still pins the local player to the newest snapshot", () => {
    const interp = new SnapshotInterpolator(EXTRAP);
    interp.push(snap(100, [moverAt(LOCAL, 40, 0, 2)]), 1000);

    const view = viewWorld();
    interp.buildView(view, 1100, 75, LOCAL);
    expect(view.players.get(LOCAL)!.kinematics.x).toBe(40); // not extrapolated
  });

  it("stamps renderTick at ~the server present, monotonically", () => {
    const interp = new SnapshotInterpolator(EXTRAP);
    interp.push(snap(100, [playerAt("r", 0, 0)]), 1000);

    // serverNow at 1204 → tick ≈ 120 (not the interp-delayed past ≈ tick 113).
    expect(interp.renderTick(1204, 75, 100)).toBe(120);
    // Monotonic across calls.
    let prev = -Infinity;
    for (let now = 1204; now <= 1500; now += 16) {
      const rt = interp.renderTick(now, 75, 100)!;
      expect(rt).toBeGreaterThanOrEqual(prev);
      prev = rt;
    }
    expect(prev).toBeGreaterThan(140);
  });

  it("releases ship-anchored events promptly (ships are no longer in the past)", () => {
    const interp = new SnapshotInterpolator(EXTRAP);
    const died: GameEvent = { type: "shipDied", victim: "r", killer: LOCAL, bounty: 0, x: 0, y: 0 };
    interp.push(snap(100, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(110, [playerAt(LOCAL, 0, 0)], [], [died]), 1100);

    const view = viewWorld();
    // With a 100ms interp delay the past-timeline renderTime (1050) hasn't
    // reached the event's tick — interpolate mode would hold it. Extrapolate
    // mode releases it now…
    interp.buildView(view, 1150, 100, LOCAL);
    expect(view.events.map((e) => e.type)).toEqual(["shipDied"]);

    // …and never again (once-only tick watermark).
    interp.buildView(view, 1250, 100, LOCAL);
    expect(view.events).toHaveLength(0);
  });

  it("eases a misprediction correction instead of snapping on a new snapshot", () => {
    const interp = new SnapshotInterpolator(EXTRAP);
    interp.push(snap(100, [moverAt("r", 100, 100, 2)]), 1000);

    const view = viewWorld();
    interp.buildView(view, 1100, 75, LOCAL); // drawn at x=120 off the old base
    // New snapshot: the ship actually slowed — true pose x=114 at tick 110, so
    // the constant-velocity guess was 6px hot at that instant.
    interp.push(snap(110, [moverAt("r", 114, 100, 1)]), 1100);
    interp.buildView(view, 1100, 75, LOCAL); // same instant: no decay yet
    // Continuity: still drawn exactly where the old base put it (offset
    // absorbed the full delta), then eases onto the corrected path.
    expect(view.players.get("r")!.kinematics.x).toBeCloseTo(120);

    interp.buildView(view, 1400, 75, LOCAL); // several half-lives later
    // Corrected path at serverNow 1400 (capped lead 250ms → 25t at 1 px/tick)
    // is x = 114 + 25 = 139; the residual offset has mostly decayed.
    const x = view.players.get("r")!.kinematics.x;
    expect(x).toBeGreaterThan(138.5);
    expect(x).toBeLessThan(140);
  });
});
