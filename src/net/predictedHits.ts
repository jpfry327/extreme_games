/**
 * Client-side predicted hit *feedback* — M2.11 (responsiveness pass).
 *
 * The problem: hits/damage are 100% server-authoritative, so the visual confirmation
 * that your shot connected — the bomb burst, the bullet spark — only arrives with
 * the server snapshot, ~1 RTT after your (predicted) shot visually overlaps the
 * enemy on your screen. Until then the shot sails *through* the enemy and the
 * explosion lands a beat late. That delay is fundamental to authoritative damage
 * (no model, Subspace included, shows a *remote* reaction faster than ~1 RTT), but
 * the *feedback* can be faked instantly and cosmetically, which is what every
 * responsive shooter does (the "hit marker now, kill confirm later" trick).
 *
 * This detector finds the moment one of *your own* predicted projectiles overlaps
 * an enemy **as drawn** (predicted shot at the present leading edge vs the enemy
 * interpolated in the past — exactly the two sprites the player sees), and reports
 * it so the caller can:
 *   1. draw the burst/spark immediately (a cosmetic `bombExploded` / `shipHit`),
 *   2. retract the predicted projectile so it detonates *there* instead of flying
 *      on (`Predictor.markHit`), and
 *   3. (bombs) suppress the delayed server copy of that explosion.
 *
 * It is **cosmetic only** — it never touches damage, energy, kills, or the death
 * explosion (those stay authoritative; no predicted kills). The accepted trade,
 * shared with the Subspace model, is the occasional false positive: a shot that
 * looked like it connected but the server scored a miss draws a burst that did no
 * damage. Only *un-acked* predicted shots are considered (`spawnSeq` present);
 * already-acked shots have their real server effect already in flight.
 */

import { shipConfig } from "../config";
import { isAlive } from "../sim/player";
import type { Player, PlayerId, Projectile } from "../sim/types";

/** One cosmetic hit to surface: where to draw it, who it struck, and the spawning
 *  input `seq` so the caller can retract the predicted projectile via the predictor. */
export interface CosmeticHit {
  kind: Projectile["kind"];
  x: number;
  y: number;
  target: PlayerId;
  seq: number;
}

export class PredictedHitDetector {
  /** Spawn-seqs already detonated once, so a projectile fires its cosmetic effect
   *  exactly once and is then skipped (and retracted by the caller). */
  private readonly hit = new Set<number>();

  /**
   * Find newly-overlapping own predicted projectiles against the drawn enemies.
   * `projectiles` are the predictor's own predicted shots; `enemies` are the
   * interpolated remote players (the caller passes everyone but the local player).
   * Each projectile detonates at most once.
   */
  detect(projectiles: readonly Projectile[], enemies: readonly Player[]): CosmeticHit[] {
    const out: CosmeticHit[] = [];
    for (const p of projectiles) {
      if (p.spawnSeq === undefined) continue; // only un-acked predicted shots
      if (this.hit.has(p.spawnSeq)) continue; // already detonated once
      for (const e of enemies) {
        if (!isAlive(e)) continue; // a respawning ghost can't be hit
        const reach = p.radius + shipConfig(e.shipType).radius;
        const dx = p.x - e.kinematics.x;
        const dy = p.y - e.kinematics.y;
        if (dx * dx + dy * dy <= reach * reach) {
          this.hit.add(p.spawnSeq);
          out.push({ kind: p.kind, x: p.x, y: p.y, target: e.id, seq: p.spawnSeq });
          break; // one hit per projectile
        }
      }
    }
    return out;
  }

  /** Whether `seq` has already cosmetically detonated this frame/earlier — used to
   *  skip rendering the projectile the same frame it detonates (the predictor
   *  retracts it from the *next* rebuild). */
  isHit(seq: number): boolean {
    return this.hit.has(seq);
  }

  /** Drop seqs at or below the server ack: those shots are now authoritative and
   *  gone from the prediction replay, so they can't reappear to re-detonate. Keeps
   *  the set bounded. */
  prune(ackedSeq: number): void {
    for (const seq of this.hit) if (seq <= ackedSeq) this.hit.delete(seq);
  }
}
