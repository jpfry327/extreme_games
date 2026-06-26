/**
 * Area-of-interest culling — M2.14.
 *
 * Two layers of contract:
 *   1. The predicate (`inViewBox`) and the snapshot filter (`filterSnapshotFor`)
 *      keep self + own shots, drop far entities, and respect AOI-edge hysteresis.
 *   2. Through `SnapshotChannel`, an entity leaving a client's AOI is an ordinary
 *      delta *removal* (clean despawn) and one re-entering is a full-entity add —
 *      and the delta-equals-full bit-for-bit guarantee from M2.13 still holds when
 *      each client's baseline is its own filtered subset.
 */

import { describe, expect, it } from "vitest";
import { AOI, WARBIRD } from "../config";
import { GameMap } from "../sim/gamemap";
import type { InputCommand, Projectile, StepContext } from "../sim/types";
import { World } from "../sim/world";
import { serializeSnapshotFor, type Snapshot } from "./snapshot";
import { defaultAoiConfig, filterSnapshotFor, inViewBox } from "./aoi";
import {
  decodeSnapshot,
  encodeSnapshot,
  MissingBaselineError,
  quantizeSnapshot,
} from "./snapshotCodec";
import { SnapshotChannel } from "./serverSnapshots";

// --- fixtures ----------------------------------------------------------------

function openMap(tiles = 64): GameMap {
  return new GameMap(tiles, tiles, new Uint8Array(tiles * tiles));
}

const NO_INPUT: InputCommand = {
  rotateLeft: false,
  rotateRight: false,
  thrust: false,
  reverse: false,
  afterburner: false,
  fire: false,
  bomb: false,
};

const ACK = { lastProcessedInputSeq: 0, inputBufferDepth: 0 };

const cfg = defaultAoiConfig();
/** AOI box half-width along x for a center viewer (no hysteresis). */
const HW = AOI.viewHalfWidth + AOI.weaponReach;

/** The full, unfiltered shared snapshot the server builds once per broadcast
 *  (mirrors server/index.ts `buildSharedSnapshot`), at an explicit tick. */
function sharedSnapshot(world: World, tick: number): Snapshot {
  return {
    tick,
    players: [...world.players.values()],
    projectiles: world.projectiles,
    events: world.events,
    lastProcessedInputSeq: 0,
    inputBufferDepth: 0,
    pings: {},
  };
}

/** Decode a snapshot as a standalone keyframe — the "full snapshot" reference. */
function decodeKeyframe(snap: Snapshot): Snapshot {
  return decodeSnapshot(encodeSnapshot(snap, null), () => undefined);
}

// --- predicate ---------------------------------------------------------------

describe("aoi — inViewBox predicate", () => {
  it("includes the center and the exact boundary, excludes just past it", () => {
    expect(inViewBox(0, 0, 0, 0, cfg)).toBe(true);
    expect(inViewBox(0, 0, HW, 0, cfg)).toBe(true); // on the edge
    expect(inViewBox(0, 0, HW + 1, 0, cfg)).toBe(false); // just past
    expect(inViewBox(0, 0, 0, AOI.viewHalfHeight + AOI.weaponReach + 1, cfg)).toBe(false);
  });

  it("hysteresis slack keeps a just-past-edge entity visible", () => {
    // Without slack it's out; with the hysteresis band it's back in.
    expect(inViewBox(0, 0, HW + 10, 0, cfg)).toBe(false);
    expect(inViewBox(0, 0, HW + 10, 0, cfg, AOI.hysteresisPx)).toBe(true);
  });
});

// --- filter over a live world ------------------------------------------------

describe("aoi — filterSnapshotFor", () => {
  it("a far player is absent; a near player and self are present", () => {
    const world = new World(openMap(), 1, false);
    const me = world.addPlayer("me", "me", 0, WARBIRD);
    me.kinematics.x = me.kinematics.prevX = 8000;
    me.kinematics.y = me.kinematics.prevY = 8000;

    const near = world.addPlayer("near", "near", 1, WARBIRD);
    near.kinematics.x = near.kinematics.prevX = 8000 + 100;
    near.kinematics.y = near.kinematics.prevY = 8000;

    const far = world.addPlayer("far", "far", 1, WARBIRD);
    far.kinematics.x = far.kinematics.prevX = 8000 + HW + 500;
    far.kinematics.y = far.kinematics.prevY = 8000;

    const ids = serializeSnapshotFor(world, "me", ACK).players.map((p) => p.id);
    expect(ids).toContain("me");
    expect(ids).toContain("near");
    expect(ids).not.toContain("far");
  });

  it("own projectiles are always included; enemy projectiles out of view are not", () => {
    const world = new World(openMap(), 1, false);
    const me = world.addPlayer("me", "me", 0, WARBIRD);
    me.kinematics.x = me.kinematics.prevX = 8000;
    me.kinematics.y = me.kinematics.prevY = 8000;

    const mk = (id: number, owner: string, x: number): Projectile => ({
      id,
      kind: "bullet",
      owner,
      x,
      y: 8000,
      vx: 0,
      vy: 0,
      life: 50,
      bounces: 0,
      radius: 2,
      alive: true,
      prevX: x,
      prevY: 8000,
    });
    // Both far outside the AOI box; only ownership should keep one in.
    world.projectiles.push(mk(1, "me", 8000 + HW + 1000));
    world.projectiles.push(mk(2, "enemy", 8000 + HW + 1000));

    const ids = serializeSnapshotFor(world, "me", ACK).projectiles.map((p) => p.id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
  });

  it("falls back to sending everything when the viewer is absent from the snapshot", () => {
    const snap = sharedSnapshot(new World(openMap(), 1, false), 0);
    expect(filterSnapshotFor(snap, "ghost", cfg)).toBe(snap);
  });
});

// --- through the per-client delta channel ------------------------------------

describe("aoi — SnapshotChannel boundary crossings", () => {
  it("despawns via delta on AOI exit and re-adds the full entity on re-entry", () => {
    const world = new World(openMap(), 1, false);
    const viewer = world.addPlayer("viewer", "viewer", 0, WARBIRD);
    const enemy = world.addPlayer("enemy", "enemy", 1, WARBIRD);
    viewer.kinematics.x = viewer.kinematics.prevX = 8000;
    viewer.kinematics.y = viewer.kinematics.prevY = 8000;
    enemy.kinematics.y = enemy.kinematics.prevY = 8000;

    const channel = new SnapshotChannel();
    const clientBaselines = new Map<number, Snapshot>();
    const decode = (bytes: Uint8Array) => decodeSnapshot(bytes, (t) => clientBaselines.get(t));
    const setEnemyX = (x: number) => (enemy.kinematics.x = enemy.kinematics.prevX = x);
    const q = (tick: number) => quantizeSnapshot(sharedSnapshot(world, tick));

    // Frame 1 — enemy just inside → keyframe, enemy present.
    setEnemyX(8000 + HW - 10);
    const d1 = decode(channel.encodeFor("viewer", q(1), 0, 0));
    clientBaselines.set(d1.tick, d1);
    expect(d1.players.map((p) => p.id).sort()).toEqual(["enemy", "viewer"]);
    channel.onAck("viewer", d1.tick);

    // Frame 2 — enemy past the box AND past the hysteresis band → delta removes it.
    setEnemyX(8000 + HW + AOI.hysteresisPx + 50);
    const b2 = channel.encodeFor("viewer", q(2), 0, 0);
    const d2 = decode(b2);
    clientBaselines.set(d2.tick, d2);
    expect(d2.players.map((p) => p.id)).toEqual(["viewer"]);
    // It rode a *delta* (the removal), not a keyframe: no baseline → can't decode.
    expect(() => decodeSnapshot(b2, () => undefined)).toThrow(MissingBaselineError);
    channel.onAck("viewer", d2.tick);

    // Frame 3 — enemy back inside → re-added as a full entity (delta == keyframe).
    setEnemyX(8000 + 100);
    const q3 = q(3);
    const d3 = decode(channel.encodeFor("viewer", q3, 0, 0));
    expect(d3.players.map((p) => p.id).sort()).toEqual(["enemy", "viewer"]);
    expect(d3).toEqual(decodeKeyframe(filterSnapshotFor(q3, "viewer", cfg)));
  });

  it("delta-applied equals full-snapshot bit-for-bit with AOI filtering in the loop", () => {
    // Two players well within view for the whole run: filtering is a pass-through,
    // so this is the M2.13 contract re-asserted through the M2.14 filter+channel.
    const world = new World(openMap(), 4242, false);
    const viewer = world.addPlayer("viewer", "viewer", 0, WARBIRD);
    const enemy = world.addPlayer("enemy", "enemy", 1, WARBIRD);
    enemy.kinematics.x = enemy.kinematics.prevX = viewer.kinematics.x + 60;
    enemy.kinematics.y = enemy.kinematics.prevY = viewer.kinematics.y;
    enemy.resources.energy = 80;

    const channel = new SnapshotChannel();
    const clientBaselines = new Map<number, Snapshot>();

    let sawDelta = false;
    let acked = -1;
    for (let t = 0; t < 240; t++) {
      const cmd: InputCommand = {
        ...NO_INPUT,
        thrust: t % 3 === 0,
        rotateRight: t % 5 === 0,
        fire: t % 4 === 0,
        bomb: t % 50 === 0,
      };
      const ctx: StepContext = { inputs: new Map([["viewer", cmd]]) };
      world.step(ctx);
      if (t % 3 !== 0) continue;

      const qt = quantizeSnapshot(sharedSnapshot(world, world.tick));
      const bytes = channel.encodeFor("viewer", qt, 0, 0);
      const decoded = decodeSnapshot(bytes, (tk) => clientBaselines.get(tk));
      expect(decoded).toEqual(decodeKeyframe(filterSnapshotFor(qt, "viewer", cfg)));
      clientBaselines.set(decoded.tick, decoded);
      if (acked >= 0) sawDelta = true; // a baseline existed → this frame was a delta
      channel.onAck("viewer", decoded.tick);
      acked = decoded.tick;
      world.events.length = 0;
    }
    expect(sawDelta).toBe(true);
  });
});
