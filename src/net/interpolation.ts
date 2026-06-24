/**
 * Client-side snapshot interpolation — M2.2.
 *
 * The server broadcasts full snapshots at ~20Hz but the renderer runs at ~60fps,
 * so applying each snapshot directly makes every entity snap 20×/sec. This module
 * smooths that out by rendering remote entities **~100ms in the past**,
 * interpolating between the two buffered snapshots that straddle that render time
 * (the canonical Source-engine approach — architecture §5.2, roadmap M2.2).
 *
 * The timeline is built from **client receive-time** (`performance.now()`), not
 * the server tick, so no clock-sync is needed.
 *
 * `buildView` bakes the interpolated pose into a *view* `World` whose `prev*`
 * fields equal `current`, so the existing renderer (which lerps `prev*→current`
 * by `alpha`) draws exactly the baked pose regardless of the `alpha` it's passed.
 * The renderer stays completely untouched.
 *
 * What this step deliberately does NOT do (kept isolated per the M2 sub-split):
 *   - the **local player** is pinned to the latest snapshot, not interpolated
 *     (still laggy; client prediction is M2.4).
 *   - **all** projectiles are interpolated, including the local player's own
 *     (own-weapon prediction is M2.6).
 */

import type { Kinematics, Player, PlayerId } from "../sim/types";
import type { World } from "../sim/world";
import type { Snapshot } from "./snapshot";

/** A snapshot tagged with the local time it arrived. */
interface BufferedSnapshot {
  snap: Snapshot;
  /** `performance.now()` ms at receipt — the interpolation timeline. */
  receivedAt: number;
}

/** How many snapshots to retain. At 20Hz that's ~1.5s of history — far more than
 *  the ~100ms interpolation window needs, leaving margin for jitter / lag spikes
 *  while still bounding memory. (Edge case: if the tab is backgrounded for
 *  >1.5s, rAF pauses while snapshots keep arriving, so un-rendered snapshots are
 *  trimmed here and their events are lost — cosmetic only, acceptable.) */
const MAX_BUFFER = 30;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Interpolate an angle the short way around the circle, so a ship crossing the
 *  0/2π seam rotates by the small arc instead of spinning all the way back. */
function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return a + d * t;
}

export class SnapshotInterpolator {
  private buffer: BufferedSnapshot[] = [];
  /** `receivedAt` of the newest snapshot whose events have already been released.
   *  Events fire once, in interpolated time, when render time passes them. */
  private lastEventTime = -Infinity;

  /** Buffer a freshly received snapshot. `nowMs` is `performance.now()`. */
  push(snap: Snapshot, nowMs: number): void {
    this.buffer.push({ snap, receivedAt: nowMs });
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
  }

  /**
   * Populate `view` with the interpolated world for render time `nowMs −
   * interpDelayMs`. Remote players/projectiles are lerped between the straddling
   * snapshot pair; the local player is pinned to the newest snapshot. Released
   * events (in interpolated time) are written to `view.events`.
   */
  buildView(view: World, nowMs: number, interpDelayMs: number, localPlayerId: PlayerId): void {
    if (this.buffer.length === 0) return;

    const newest = this.buffer[this.buffer.length - 1];
    const renderTime = nowMs - interpDelayMs;

    // --- pick the straddling snapshot pair a (older) .. b (newer) -------------
    let a: BufferedSnapshot;
    let b: BufferedSnapshot;
    let t: number;
    if (renderTime <= this.buffer[0].receivedAt) {
      // Before our oldest sample (buffer warming up) — clamp to the oldest pose.
      a = b = this.buffer[0];
      t = 0;
    } else if (renderTime >= newest.receivedAt) {
      // We've caught up to (or past) the newest sample — hold it, don't
      // extrapolate. The roadmap's buffer-starvation fallback.
      a = b = newest;
      t = 0;
    } else {
      // Advance until renderTime falls inside [buffer[i], buffer[i+1]].
      let i = 0;
      while (i < this.buffer.length - 1 && this.buffer[i + 1].receivedAt < renderTime) i++;
      a = this.buffer[i];
      b = this.buffer[i + 1];
      const span = b.receivedAt - a.receivedAt;
      t = span > 0 ? (renderTime - a.receivedAt) / span : 0;
    }

    view.tick = newest.snap.tick;

    // --- players -------------------------------------------------------------
    const olderPlayers = new Map(a.snap.players.map((p) => [p.id, p]));
    view.players.clear();
    for (const bp of b.snap.players) {
      if (bp.id === localPlayerId) continue; // local handled below, from newest
      view.players.set(bp.id, interpolatePlayer(olderPlayers.get(bp.id), bp, t));
    }
    // The local player is NOT interpolated — render it from the latest
    // authoritative snapshot (still laggy; prediction lands in M2.4).
    const localNewest = newest.snap.players.find((p) => p.id === localPlayerId);
    if (localNewest) view.players.set(localNewest.id, pinPlayer(localNewest));

    // --- projectiles ---------------------------------------------------------
    const olderProj = new Map(a.snap.projectiles.map((p) => [p.id, p]));
    view.projectiles.length = 0;
    for (const bp of b.snap.projectiles) {
      const ap = olderProj.get(bp.id);
      const x = ap ? lerp(ap.x, bp.x, t) : bp.x;
      const y = ap ? lerp(ap.y, bp.y, t) : bp.y;
      view.projectiles.push({ ...bp, x, y, prevX: x, prevY: y });
    }

    // --- events: release each snapshot's events once, in interpolated time ---
    // The watermark is a strict `>`: two snapshots sharing an identical
    // receivedAt (same performance.now() tick) would drop the second's events,
    // but at 20Hz that collision effectively never happens.
    view.events.length = 0;
    for (const buf of this.buffer) {
      if (buf.receivedAt > this.lastEventTime && buf.receivedAt <= renderTime) {
        for (const e of buf.snap.events) view.events.push(e);
        this.lastEventTime = buf.receivedAt;
      }
    }
  }
}

/** Build a view player at the interpolated pose between `older` and `newer`.
 *  A fresh kinematics object is required — mutating the buffered snapshot's would
 *  corrupt the next frame's interpolation. Other components are read-only in the
 *  renderer/HUD, so they're shared by reference. */
function interpolatePlayer(older: Player | undefined, newer: Player, t: number): Player {
  // Only interpolate from a *live* previous pose. With no older sample (the
  // player just joined) or a dead one (they respawned this interval — their
  // older pose is the death site), lerping would streak the ship across the map
  // from its old position. Pin to the fresh pose instead, so a join/respawn pops
  // in cleanly. (This is what PlayerSpawnedEvent guards against — sim/types.ts.)
  if (!older || older.combat.respawnAt !== 0) return pinPlayer(newer);

  const nk = newer.kinematics;
  const ok = older.kinematics;
  const x = lerp(ok.x, nk.x, t);
  const y = lerp(ok.y, nk.y, t);
  const rotation = lerpAngle(ok.rotation, nk.rotation, t);
  return { ...newer, kinematics: bakedKinematics(nk, x, y, rotation) };
}

/** Build a view player pinned to the snapshot pose (no interpolation). */
function pinPlayer(p: Player): Player {
  const k = p.kinematics;
  return { ...p, kinematics: bakedKinematics(k, k.x, k.y, k.rotation) };
}

/** Kinematics with the given pose and `prev* === current`, so the renderer's
 *  `prev→current` lerp is a no-op and draws exactly this pose. Velocity is
 *  carried through unchanged (unused by the renderer, but keeps the shape whole). */
function bakedKinematics(src: Kinematics, x: number, y: number, rotation: number): Kinematics {
  return {
    x,
    y,
    vx: src.vx,
    vy: src.vy,
    rotation,
    prevX: x,
    prevY: y,
    prevRotation: rotation,
  };
}
