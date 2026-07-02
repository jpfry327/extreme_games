/**
 * Remote-ship extrapolation to the estimated server present — M2.17 Phase D.
 *
 * Interpolation (M2.2) draws remote ships 30–120ms in the past, plus ~RTT/2 of
 * wire age — the main remaining feel gap vs original Subspace, which drew
 * remotes dead-reckoned at the present. This module is the `"extrapolate"` mode
 * of `NET.remoteShips`: each remote ship is based on the **newest** snapshot and
 * advanced at constant velocity to the estimated server present — the same
 * pattern `RemoteProjectileSimulator` (M2.16) uses for remote shots, so ships
 * and the bullets they fire finally live on one timeline. Ships differ from
 * projectiles in two ways, both handled here:
 *
 *   - **Walls.** A coasting ship still bounces. Whole ticks advance through
 *     `moveAndCollide` (`sim/collision.ts`) — the exact move+bounce treatment
 *     `movementSystem` gives ships, shared rather than duplicated — with the
 *     sub-tick remainder linear (a bounce landing mid-sub-tick is sub-pixel,
 *     same accepted rounding as remote projectiles).
 *   - **Corrections.** A ship has input we can't see: each new snapshot reveals
 *     the constant-velocity misprediction as a pose delta. That delta is
 *     absorbed into a per-ship decaying render offset (the
 *     `ReconciliationSmoother` pattern, generalized to a per-player map):
 *     `before` (this frame's pose from the *old* base) minus `after` (from the
 *     new base) is added to the offset at snapshot arrival, decays with
 *     `correctionHalfLifeMs`, and snaps past `NET.maxSmoothDistancePx`
 *     (respawn/teleport rule, same as the local ship). Both poses are computed
 *     for the same target time, so the delta is pure misprediction, not motion.
 *
 * Freeze at the lead cap during stalls, exactly like projectiles: the lead
 * window is clamped to `maxLeadMs`, so a stalled link shows ships frozen at the
 * cap rather than gliding unboundedly on stale velocity, and recovery is an
 * eased correction rather than a warp (unless it exceeds the snap distance).
 *
 * Dead ships pin to the snapshot pose with the offset cleared, and no
 * correction is absorbed across a death/respawn (the older base is the death
 * site) — the same guard `interpolatePlayer` applies — so respawns pop cleanly.
 *
 * Rotation is pinned to the newest snapshot's value (turning is exactly the
 * input we can't predict), smoothed through the same offset so a mid-turn
 * snapshot eases rather than snaps.
 */

import { NET, TICK_DT, shipConfig } from "../config";
import { moveAndCollide } from "../sim/collision";
import type { GameMap } from "../sim/gamemap";
import type { Kinematics, Player, PlayerId } from "../sim/types";

/** One sim tick in ms (duplicated from interpolation.ts to avoid a module
 *  cycle — the interpolator imports this module). */
const TICK_MS = 1000 * TICK_DT;

export interface RemoteShipsConfig {
  mode: "extrapolate" | "interpolate";
  maxLeadMs: number;
  correctionHalfLifeMs: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Shortest signed angular difference `a → b`, in (−π, π] (same as the
 *  ReconciliationSmoother's). */
function angleDelta(a: number, b: number): number {
  const twoPi = Math.PI * 2;
  let d = (a - b) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return d;
}

/** Per-remote-player extrapolation state: the snapshot base last used (so a new
 *  base can be detected and its misprediction measured) plus the decaying
 *  correction offset. */
interface RemoteState {
  baseTick: number;
  /** The buffered snapshot's player — read-only; never mutated. */
  base: Player;
  offX: number;
  offY: number;
  offRot: number;
}

/** A constant-velocity pose advanced from a snapshot base — the raw
 *  extrapolation before the correction offset is applied. */
interface ExtrapolatedPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Advance a player's snapshot kinematics at constant velocity from `baseTick`
 * to `targetTimeMs` (tick-timeline ms), lead clamped to `[0, maxLeadMs]` —
 * freeze-at-cap. Whole ticks go through the ships' wall move+bounce
 * (`moveAndCollide`, radius/bounceFactor from the ship's config); the sub-tick
 * remainder is linear. Pure — reads the player, never writes it.
 */
export function extrapolatePose(
  p: Player,
  baseTick: number,
  targetTimeMs: number,
  maxLeadMs: number,
  map: GameMap,
): ExtrapolatedPose {
  const cfg = shipConfig(p.shipType);
  const leadMs = clamp(targetTimeMs - baseTick * TICK_MS, 0, maxLeadMs);
  const leadTicks = leadMs / TICK_MS;
  const wholeTicks = Math.floor(leadTicks);
  const frac = leadTicks - wholeTicks;

  let { x, y, vx, vy } = p.kinematics;
  for (let i = 0; i < wholeTicks; i++) {
    const r = moveAndCollide(map, x, y, vx, vy, cfg.radius, cfg.bounceFactor);
    x = r.x;
    y = r.y;
    vx = r.vx;
    vy = r.vy;
  }
  return { x: x + vx * frac, y: y + vy * frac, vx, vy };
}

export class RemoteShipExtrapolator {
  private states = new Map<PlayerId, RemoteState>();
  /** Last `build` call's clock, for the offset decay's dt. */
  private lastNowMs: number | null = null;

  constructor(private readonly cfg: RemoteShipsConfig = NET.remoteShips) {}

  /**
   * Build the render-view remote players (owner ≠ `localPlayerId`) for the
   * newest snapshot's `players` at the estimated server present. `nowMs` is the
   * client clock (`performance.now()`), used only to decay correction offsets.
   * Returned players are fresh objects with `prev* === current` (the baked-pose
   * convention), sharing non-kinematics components with the snapshot by
   * reference like the interpolator does.
   */
  build(
    players: readonly Player[],
    newestTick: number,
    serverNowMs: number,
    nowMs: number,
    localPlayerId: PlayerId,
    map: GameMap,
  ): Player[] {
    // Freeze-at-cap: the shared target time never leads the base by more than
    // maxLeadMs, so during a stall every ship holds at the cap together.
    const targetTimeMs =
      newestTick * TICK_MS + clamp(serverNowMs - newestTick * TICK_MS, 0, this.cfg.maxLeadMs);

    // Decay every ship's correction offset by the real elapsed frame time.
    const dtMs = this.lastNowMs === null ? 0 : Math.max(0, nowMs - this.lastNowMs);
    this.lastNowMs = nowMs;
    const decay = Math.pow(0.5, dtMs / this.cfg.correctionHalfLifeMs);

    const out: Player[] = [];
    const seen = new Set<PlayerId>();
    for (const p of players) {
      if (p.id === localPlayerId) continue; // prediction owns the local ship
      seen.add(p.id);

      const prior = this.states.get(p.id);
      const dead = p.combat.respawnAt !== 0;
      let st: RemoteState;
      if (!prior) {
        // First sight (join / re-entered AOI): pop in at the pose, no offset.
        st = { baseTick: newestTick, base: p, offX: 0, offY: 0, offRot: 0 };
      } else {
        st = prior;
        st.offX *= decay;
        st.offY *= decay;
        st.offRot *= decay;
        if (st.baseTick !== newestTick) {
          // New base for this ship — absorb the misprediction it reveals,
          // unless it spans a death/respawn (the old base is the death site;
          // pin cleanly, same guard as interpolatePlayer).
          if (dead || st.base.combat.respawnAt !== 0) {
            st.offX = st.offY = st.offRot = 0;
          } else {
            const before = extrapolatePose(st.base, st.baseTick, targetTimeMs, this.cfg.maxLeadMs, map);
            const after = extrapolatePose(p, newestTick, targetTimeMs, this.cfg.maxLeadMs, map);
            const dx = before.x - after.x;
            const dy = before.y - after.y;
            if (Math.hypot(st.offX + dx, st.offY + dy) > NET.maxSmoothDistancePx) {
              // Teleport-class jump (warp / hard divergence) — snap, don't slide.
              st.offX = st.offY = st.offRot = 0;
            } else {
              st.offX += dx;
              st.offY += dy;
              st.offRot += angleDelta(st.base.kinematics.rotation, p.kinematics.rotation);
            }
          }
          st.baseTick = newestTick;
          st.base = p;
        }
      }
      this.states.set(p.id, st);

      if (dead) {
        // Dead ships don't move; pin to the snapshot pose (renderer hides them,
        // but HUD/nametags still read the entry) and drop any pending offset.
        st.offX = st.offY = st.offRot = 0;
        out.push(bakedPlayer(p, p.kinematics.x, p.kinematics.y, p.kinematics.rotation));
        continue;
      }

      const pose = extrapolatePose(p, newestTick, targetTimeMs, this.cfg.maxLeadMs, map);
      out.push(
        bakedPlayer(
          p,
          pose.x + st.offX,
          pose.y + st.offY,
          p.kinematics.rotation + st.offRot,
          pose.vx,
          pose.vy,
        ),
      );
    }

    // Drop state for ships gone from the snapshot (left / out of AOI), so a
    // re-entry pops in fresh instead of absorbing a bogus map-spanning delta.
    for (const id of this.states.keys()) {
      if (!seen.has(id)) this.states.delete(id);
    }
    return out;
  }
}

/** A fresh view player at the given pose with `prev* === current`, so the
 *  renderer's `prev→current` alpha-lerp draws exactly this pose. */
function bakedPlayer(
  p: Player,
  x: number,
  y: number,
  rotation: number,
  vx = p.kinematics.vx,
  vy = p.kinematics.vy,
): Player {
  const k: Kinematics = {
    x,
    y,
    vx,
    vy,
    rotation,
    prevX: x,
    prevY: y,
    prevRotation: rotation,
  };
  return { ...p, kinematics: k };
}
