/**
 * Deterministic client-side simulation of remote projectiles — M2.8, moved to
 * the **estimated server present** as part of the tick-timeline desync fix.
 *
 * Through M2.6 *every other* player's bullets were drawn by lerping their
 * streamed snapshot positions (`interpolation.ts`, now removed). That produced
 * two artifacts unique to enemy fire: a bullet that bounced off a wall *between*
 * two snapshots was drawn as a straight line through the corner until the
 * post-bounce snapshot arrived (the "teleport"), and all enemy fire trailed by
 * the interpolation delay in a way that read as inferred rather than physical.
 *
 * The fix is the same determinism the local player (M2.4) and its own shots
 * (M2.6) already exploit, turned outward: a projectile's entire future is fixed
 * at spawn. `stepProjectile` (`sim/systems/projectiles.ts`) advances it from
 * *only* position, velocity, bounce count, and the map — **no player input drives
 * it** — so any client holding the spawn state can reproduce its path bit-for-bit,
 * bounces included. So instead of lerping streamed positions we take the latest
 * authoritative remote projectiles and **simulate them forward** to render time.
 *
 * Render time (the crux): remote bullets are simulated to the **estimated server
 * present** (`SnapshotInterpolator.serverNowMs`), NOT the ships' interpolated
 * past. M2.8 kept them on the ships' timeline, which is self-consistent for the
 * *attacker's* view — but it lies to the *defender*: the local ship is predicted
 * at present while the bullet that is about to hit it was drawn ~interpDelay
 * (+ the wire) behind its true position, so a server-adjudicated hit landed
 * while the bullet still looked far away ("the bullet was far away, yet I
 * died"). Unlike ships, projectiles have no input, so extrapolating them to the
 * present is near-exact — the honest place to draw a threat. The cost, priced
 * in deliberately:
 *   - a bullet is detached from its firer's (past-rendered) muzzle by the view
 *     delay's worth of travel — reads as the shot leading the ship, which is
 *     what original Subspace looked like too;
 *   - a first-seen bullet pops in already ~RTT/2 + a snapshot gap down its
 *     path (no catch-up blend — a blend would re-introduce exactly the
 *     "drawn behind truth" lie during the dodge-critical near-muzzle window);
 *   - a bullet the server killed is over-drawn by up to the lead window until
 *     the removing snapshot lands, then vanishes; the authoritative
 *     `bombExploded` / `shipHit` event draws the impact at the true spot
 *     (released promptly — see `buildView`).
 *
 * This is **not** server-side lag compensation / hit rewind (M2.9, a server
 * feature for hit *fairness*). Hits and damage stay 100% server-authoritative;
 * this simulation is cosmetic-until-confirmed, exactly like predicted own-shots.
 */

import type { GameMap } from "../sim/gamemap";
import type { PlayerId, Projectile } from "../sim/types";
import { projectileSystem } from "../sim/systems/projectiles";
import { World } from "../sim/world";
import { type BufferedSnapshot, TICK_MS } from "./interpolation";

export class RemoteProjectileSimulator {
  /** A tiny, never-networked world holding *only* a map. Each `simulate` call
   *  reloads it with the base snapshot's remote projectiles and steps them
   *  forward. It has no players, so its collision/damage systems never fire —
   *  but we only run `projectileSystem` on it anyway (flight + wall bounce). */
  private readonly world: World;

  constructor(map: GameMap) {
    this.world = new World(map, 1, false);
  }

  /**
   * Compute the render poses of all **remote** projectiles (owner ≠ the local
   * player) at `presentTimeMs` — the estimated server present
   * (`SnapshotInterpolator.serverNowMs`; null before the first snapshot) — by
   * simulating the newest authoritative snapshot forward.
   *
   * The base is always the newest buffered snapshot: determinism makes the
   * hand-off seamless (stepping tick T by k equals stepping tick T+3 by k−3 for
   * a surviving bullet), and a bullet the server removed is simply absent from
   * the base — retraction needs no cross-check. The forward window is clamped
   * to `maxLeadMs`: during a stall longer than that, bullets freeze at the cap
   * (the same philosophy as the ships' extrapolation freeze) rather than flying
   * unboundedly on stale state.
   *
   * Returns fresh `Projectile` objects with `prev* === current`, so the renderer
   * (which lerps `prev→current` by `alpha`) draws exactly the simulated pose —
   * same baking convention the interpolator uses for ships.
   */
  simulate(
    snapshots: readonly BufferedSnapshot[],
    presentTimeMs: number | null,
    localPlayerId: PlayerId,
    maxLeadMs: number,
  ): Projectile[] {
    if (presentTimeMs === null || snapshots.length === 0) return [];
    const newest = snapshots[snapshots.length - 1];

    // Take the newest snapshot's live remote projectiles (the local player's
    // own shots come from the Predictor — M2.6).
    const base = newest.snap.projectiles.filter((p) => p.alive && p.owner !== localPlayerId);
    if (base.length === 0) return [];

    // Forward window: from the base snapshot's tick to the estimated server
    // present, clamped to [0, maxLeadMs].
    const stepMs = Math.min(Math.max(0, presentTimeMs - newest.snap.tick * TICK_MS), maxLeadMs);
    const stepTicks = stepMs / TICK_MS;
    const wholeTicks = Math.floor(stepTicks);
    const frac = stepTicks - wholeTicks; // sub-tick remainder for smooth motion

    // Clone into the tiny world (structuredClone so stepping never mutates the
    // buffered snapshot, which the next frame still reads) and run the
    // deterministic projectile step `wholeTicks` times.
    this.world.projectiles = structuredClone(base);
    for (let i = 0; i < wholeTicks; i++) projectileSystem(this.world);

    const survivors = this.world.projectiles.filter((p) => p.alive);

    // Bake the render pose: advance by the sub-tick remainder (linear — a bounce
    // landing mid-sub-tick is sub-pixel and ignored) and pin prev === current.
    return survivors.map((p) => {
      const x = p.x + p.vx * frac;
      const y = p.y + p.vy * frac;
      return { ...p, x, y, prevX: x, prevY: y };
    });
  }
}
