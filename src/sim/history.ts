/**
 * Per-tick world pose history — the data structure server-side lag compensation
 * (M2.9) reads. A short ring of past player poses, populated at the end of every
 * `World.step()`, so the collision system can test a projectile against where a
 * target *was* `compTicks` ago instead of where it is now.
 *
 * Why this fits the architecture (architecture §5, roadmap M2.9): Layer A is
 * plain, cloneable data, so keeping a ring of past poses is cheap, and lag comp
 * is just "read a past sample" — *not* the classic mutate-rewind-test-restore
 * dance. We store only what a hit test needs (`{x, y, radius, alive}`), not whole
 * `Player`s, so the ring stays small.
 *
 * This is **runtime-only state**, like `World.events`/`World.contacts`: it is
 * never serialized into a snapshot (the client never accrues it — its view world
 * isn't stepped and its predicted world has no remote targets). It lives on the
 * server's authoritative world.
 *
 * Determinism: `record`/`lookup` are pure functions of the tick stream, so two
 * worlds fed identical inputs build identical history and resolve identical hits
 * — the `determinism.test.ts` contract the whole prediction story rests on.
 */

import { shipConfig } from "../config";
import type { Player, PlayerId } from "./types";

/** The minimal slice of a player's pose a lag-compensated hit test needs. */
export interface HistoricalPose {
  x: number;
  y: number;
  /** The ship's collision radius at that tick (copied so the test needs no config
   *  lookup, and so a future per-tick radius change would be honoured). */
  radius: number;
  /** Whether the player was alive (collidable) at that tick. A target that was a
   *  ghost in the firer's view — dead/respawning — can't be hit by a rewound shot. */
  alive: boolean;
}

/** One recorded tick: the absolute tick number plus every player's pose then. The
 *  tick is stored alongside the poses so a ring slot can be validated against the
 *  tick being looked up — a stale wrapped-around slot reads as "out of range". */
interface HistoryFrame {
  tick: number;
  poses: Map<PlayerId, HistoricalPose>;
}

/**
 * A fixed-size ring of the last `size` ticks of player poses. Indexed by
 * `tick % size`; the stored frame's `tick` disambiguates a live slot from a
 * wrapped-around stale one, so `lookup` of an evicted or not-yet-recorded tick
 * safely returns `null` (the caller falls back to the present pose).
 */
export class TickHistory {
  private readonly frames: (HistoryFrame | null)[];

  constructor(private readonly size: number) {
    this.frames = new Array(size).fill(null);
  }

  /** Record every player's pose at `tick`. Called once per `World.step()`, after
   *  movement, so the frame holds the players' end-of-tick positions. Reuses the
   *  ring slot's `Map` to avoid per-tick allocation. */
  record(tick: number, players: Map<PlayerId, Player>): void {
    const slot = ((tick % this.size) + this.size) % this.size;
    let frame = this.frames[slot];
    if (!frame) {
      frame = { tick, poses: new Map() };
      this.frames[slot] = frame;
    } else {
      frame.tick = tick;
      frame.poses.clear();
    }
    for (const p of players.values()) {
      const k = p.kinematics;
      frame.poses.set(p.id, {
        x: k.x,
        y: k.y,
        radius: shipConfig(p.shipType).radius,
        alive: p.combat.respawnAt === 0,
      });
    }
  }

  /** The pose of `playerId` at `tick`, or `null` if that tick isn't in the ring
   *  (evicted, never recorded, or beyond what's been stepped). The caller treats
   *  `null` as "use the present pose" — so lag comp degrades gracefully to no
   *  compensation rather than ever reading a wrong (wrapped) sample. */
  lookup(tick: number, playerId: PlayerId): HistoricalPose | null {
    if (tick < 0) return null;
    const slot = ((tick % this.size) + this.size) % this.size;
    const frame = this.frames[slot];
    if (!frame || frame.tick !== tick) return null;
    return frame.poses.get(playerId) ?? null;
  }
}
